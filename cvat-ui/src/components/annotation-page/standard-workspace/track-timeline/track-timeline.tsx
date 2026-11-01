// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, {
    useCallback, useMemo, useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import Select from 'antd/lib/select';
import Input from 'antd/lib/input';
import Checkbox from 'antd/lib/checkbox';
import Text from 'antd/lib/typography/Text';

import { Attribute, Label } from 'cvat-core-wrapper';
import { Chapter } from 'cvat-core/src/frames';
import { ActiveControl, ColorBy, CombinedState } from 'reducers';
import { activateObject, changeFrameAsync, switchPlay } from 'actions/annotation-actions';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import { getCVATStore } from 'cvat-store';
import CVATTooltip from 'components/common/cvat-tooltip';
import GlobalHotKeys from 'utils/mousetrap-react';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { useUpdateEffect } from 'utils/hooks';
import { clamp } from 'utils/math';
import { ThunkDispatch, shallowEqual } from 'utils/redux';
import {
    TimelineRow, TimelineSortMode, filterRows, isAliveAt, nearestAliveFrame, sortRows,
} from 'utils/track-timeline';
import TimelineCanvas from './timeline-canvas';
import useTimelineRows from './use-timeline-rows';

const STORAGE_KEY = 'cvat.trackTimeline';
const HEADER_HEIGHT = 28;
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 80;
const NO_CHAPTERS: Chapter[] = [];

const componentShortcuts = {
    SWITCH_TRACK_TIMELINE: {
        name: 'Track timeline',
        description: 'Show or hide the track timeline panel',
        sequences: ['alt+t'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
};

registerComponentShortcuts(componentShortcuts);

interface StoredSettings {
    open: boolean;
    height: number;
}

function maxHeight(): number {
    return Math.max(Math.floor(window.innerHeight * 0.5), MIN_HEIGHT);
}

function readSettings(): StoredSettings {
    const settings: StoredSettings = { open: true, height: DEFAULT_HEIGHT };
    try {
        const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
        if (typeof stored.open === 'boolean') settings.open = stored.open;
        if (typeof stored.height === 'number') settings.height = stored.height;
    } catch {
        // storage is not available, use defaults
    }

    return settings;
}

function writeSettings(settings: StoredSettings): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // storage is not available, settings are not remembered
    }
}

const sortOptions: { value: TimelineSortMode; label: string }[] = [
    { value: 'first_appearance', label: 'First appearance' },
    { value: 'id', label: 'ID' },
    { value: 'label', label: 'Label' },
];

function TrackTimeline(): JSX.Element {
    const dispatch = useDispatch<ThunkDispatch>();
    const {
        frame, playing, activatedStateID, startFrame, stopFrame, chapters, labels, colorBy, keyMap, normalizedKeyMap,
    } = useSelector((state: CombinedState) => ({
        frame: state.annotation.player.frame.number,
        playing: state.annotation.player.playing,
        activatedStateID: state.annotation.annotations.activatedStateID,
        startFrame: state.annotation.job.instance?.startFrame ?? 0,
        stopFrame: state.annotation.job.instance?.stopFrame ?? 0,
        chapters: state.annotation.job.meta?.chapters ?? null,
        labels: state.annotation.job.labels,
        colorBy: state.settings.shapes.colorBy,
        keyMap: state.shortcuts.keyMap,
        normalizedKeyMap: state.shortcuts.normalizedKeyMap,
    }), shallowEqual);

    const [settings, setSettings] = useState<StoredSettings>(readSettings);
    const [dragging, setDragging] = useState(false);
    const [sortMode, setSortMode] = useState<TimelineSortMode>('first_appearance');
    const [query, setQuery] = useState('');
    const [onlyVisible, setOnlyVisible] = useState(false);
    const [attributeName, setAttributeName] = useState<string | null>(null);

    const { open } = settings;
    const height = open ? clamp(settings.height, MIN_HEIGHT, maxHeight()) : HEADER_HEIGHT;
    const { rows, deletedRanges, colors } = useTimelineRows(open, attributeName);

    // the same colors as in the objects sidebar
    const coloredRows = useMemo(() => {
        if (colorBy === ColorBy.LABEL) {
            return rows;
        }

        return rows.map((row) => {
            const objectColors = colors.get(row.clientID);
            if (!objectColors) {
                return row;
            }

            return { ...row, color: colorBy === ColorBy.INSTANCE ? objectColors.instance : objectColors.group };
        });
    }, [rows, colors, colorBy]);

    const attributeOptions = useMemo(() => {
        const names = new Set<string>();
        labels.forEach((label: Label) => label.attributes
            .filter((attribute: Attribute) => !attribute.mutable)
            .forEach((attribute: Attribute) => names.add(attribute.name)));
        return [...names].sort().map((name) => ({ value: name, label: name }));
    }, [labels]);

    const sortedRows = useMemo(() => sortRows(coloredRows, sortMode), [coloredRows, sortMode]);
    const queriedRows = useMemo(() => filterRows(sortedRows, query), [sortedRows, query]);
    const visibleRows = useMemo(() => (
        onlyVisible ? filterRows(queriedRows, '', frame) : queriedRows
    ), [queriedRows, onlyVisible, onlyVisible ? frame : null]);

    const toggle = useCallback(() => {
        setSettings((current) => {
            const updated = { ...current, open: !current.open };
            writeSettings(updated);
            return updated;
        });
    }, []);

    // the canvas layout computes its height from the window and the panel height
    useUpdateEffect(() => {
        window.dispatchEvent(new Event('resize'));
    }, [open]);

    const onResizeStart = (event: React.MouseEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        const onMove = (moveEvent: MouseEvent): void => {
            const updatedHeight = clamp(startHeight + startY - moveEvent.clientY, MIN_HEIGHT, maxHeight());
            setSettings((current) => ({ ...current, height: updatedHeight }));
        };
        const onUp = (): void => {
            window.removeEventListener('mousemove', onMove);
            setDragging(false);
            setSettings((current) => {
                writeSettings(current);
                return current;
            });
            window.dispatchEvent(new Event('resize'));
        };

        setDragging(true);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp, { once: true });
    };

    const onJump = useCallback(async (toFrame: number, clientID: number | null): Promise<void> => {
        const { player } = getCVATStore().getState().annotation;
        if (player.navigationBlocked) {
            return;
        }

        if (player.playing) {
            dispatch(switchPlay(false));
        }

        // the object must exist in the states of the new frame before it can be activated
        await dispatch(changeFrameAsync(clamp(toFrame, startFrame, stopFrame)));
        if (clientID !== null) {
            dispatch(activateObject(clientID, null, null));
        }
    }, [startFrame, stopFrame]);

    const onHoverRow = useCallback((row: TimelineRow): void => {
        const { annotation } = getCVATStore().getState();
        const { ready, activeControl } = annotation.canvas;
        if (
            ready && activeControl === ActiveControl.CURSOR &&
            annotation.annotations.activatedStateID !== row.clientID &&
            isAliveAt(row.segments, annotation.player.frame.number)
        ) {
            dispatch(activateObject(row.clientID, null, null));
        }
    }, []);

    const onLabelClick = useCallback((row: TimelineRow): void => {
        const { number: currentFrame } = getCVATStore().getState().annotation.player.frame;
        const targetFrame = nearestAliveFrame(row.segments, currentFrame);
        if (targetFrame !== null) {
            onJump(targetFrame, row.clientID);
        }
    }, [onJump]);

    const handlers = {
        SWITCH_TRACK_TIMELINE: (event?: KeyboardEvent) => {
            event?.preventDefault();
            toggle();
        },
    };

    const toggleTitle = `${open ? 'Hide' : 'Show'} track timeline ${normalizedKeyMap.SWITCH_TRACK_TIMELINE ?? ''}`;
    let className = 'cvat-track-timeline';
    if (!open) className += ' cvat-track-timeline-collapsed';
    if (dragging) className += ' cvat-track-timeline-dragging';

    return (
        <div className={className} style={{ height }}>
            <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
            {open && (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                <div className='cvat-track-timeline-resize-handle' onMouseDown={onResizeStart} />
            )}
            <div className='cvat-track-timeline-header' style={{ height: HEADER_HEIGHT }}>
                <Text strong className='cvat-track-timeline-title'>Tracks</Text>
                <Text type='secondary' className='cvat-track-timeline-count'>
                    {visibleRows.length === rows.length ? rows.length : `${visibleRows.length} / ${rows.length}`}
                </Text>
                {open && (
                    <>
                        <Select
                            size='small'
                            className='cvat-track-timeline-sort'
                            value={sortMode}
                            options={sortOptions}
                            onChange={(value: TimelineSortMode) => setSortMode(value)}
                            popupMatchSelectWidth={false}
                        />
                        <Input
                            size='small'
                            allowClear
                            className='cvat-track-timeline-filter'
                            placeholder='Filter: #id or label'
                            value={query}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
                        />
                        <Checkbox
                            className='cvat-track-timeline-only-visible'
                            checked={onlyVisible}
                            onChange={(event) => setOnlyVisible(event.target.checked)}
                        >
                            Visible on this frame
                        </Checkbox>
                        {attributeOptions.length > 0 && (
                            <Select
                                size='small'
                                allowClear
                                className='cvat-track-timeline-attribute'
                                placeholder='Show attribute'
                                value={attributeName ?? undefined}
                                options={attributeOptions}
                                onChange={(value: string | undefined) => setAttributeName(value ?? null)}
                                popupMatchSelectWidth={false}
                            />
                        )}
                    </>
                )}
                <CVATTooltip title={toggleTitle}>
                    <span
                        role='button'
                        tabIndex={0}
                        className='cvat-track-timeline-toggle'
                        onClick={toggle}
                        onKeyDown={(event: React.KeyboardEvent) => {
                            if (event.key === 'Enter') toggle();
                        }}
                    >
                        {open ? <DownOutlined /> : <UpOutlined />}
                    </span>
                </CVATTooltip>
            </div>
            {open && (
                <TimelineCanvas
                    rows={visibleRows}
                    deletedRanges={deletedRanges}
                    chapters={chapters ?? NO_CHAPTERS}
                    startFrame={startFrame}
                    stopFrame={stopFrame}
                    frame={frame}
                    playing={playing}
                    activatedStateID={activatedStateID}
                    onJump={onJump}
                    onHoverRow={onHoverRow}
                    onLabelClick={onLabelClick}
                />
            )}
        </div>
    );
}

export default React.memo(TrackTimeline);
