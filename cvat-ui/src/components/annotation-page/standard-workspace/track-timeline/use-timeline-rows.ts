// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    useEffect, useMemo, useRef, useState,
} from 'react';
import { useSelector } from 'react-redux';

import { Attribute, Label } from 'cvat-core-wrapper';
import { CombinedState } from 'reducers';
import { shallowEqual } from 'utils/redux';
import {
    TimelineLabelInput, TimelineRange, TimelineRow, buildTimelineRows, framesToRanges,
} from 'utils/track-timeline';

const RECOMPUTE_DEBOUNCE_MS = 300;

interface TimelineData {
    rows: TimelineRow[];
    deletedRanges: TimelineRange[];
    ready: boolean;
}

// The annotation history object is recreated on every frame change too (CHANGE_FRAME_SUCCESS),
// so it can not be used as a dependency directly. Annotations are considered changed when
// the history content changes, or when the history object changes while the frame stays the same
// (the content may stay the same when the history is full and the same action is repeated).
function useAnnotationsVersion(): number {
    const { history, frame } = useSelector((state: CombinedState) => ({
        history: state.annotation.annotations.history,
        frame: state.annotation.player.frame.number,
    }), shallowEqual);

    const [version, setVersion] = useState(0);
    const latest = useRef({ history, frame, content: '' });

    useEffect(() => {
        const content = JSON.stringify([history.undo, history.redo]);
        const previous = latest.current;
        if (previous.history !== history && (previous.content !== content || previous.frame === frame)) {
            setVersion((value) => value + 1);
        }
        latest.current = { history, frame, content };
    }, [history, frame]);

    return version;
}

export default function useTimelineRows(enabled: boolean, attributeName: string | null): TimelineData {
    const {
        jobInstance, labels, meta, initialized,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        labels: state.annotation.job.labels,
        meta: state.annotation.job.meta,
        initialized: state.annotation.annotations.initialized,
    }), shallowEqual);

    const version = useAnnotationsVersion();
    const [data, setData] = useState<TimelineData>({ rows: [], deletedRanges: [], ready: false });
    const computed = useRef(false);

    const timelineLabels = useMemo((): TimelineLabelInput[] => labels.map((label: Label) => ({
        id: label.id as number,
        name: label.name,
        color: label.color as string,
        // only immutable attributes are serialized on the track level
        attributes: label.attributes
            .filter((attribute: Attribute) => !attribute.mutable)
            .map((attribute: Attribute) => ({ id: attribute.id as number, name: attribute.name })),
    })), [labels]);

    useEffect(() => {
        if (!enabled || !jobInstance || !initialized) {
            return () => {};
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            const { startFrame, stopFrame } = jobInstance;
            const { tracks } = await jobInstance.annotations.export();
            if (cancelled) {
                return;
            }

            const rows = buildTimelineRows(tracks, timelineLabels, startFrame, stopFrame, attributeName);
            const deletedFrames = Object.keys(meta?.deletedFrames ?? {})
                .map((frame) => +frame)
                .filter((frame) => frame >= startFrame && frame <= stopFrame);
            computed.current = true;
            setData({ rows, deletedRanges: framesToRanges(deletedFrames), ready: true });
        }, computed.current ? RECOMPUTE_DEBOUNCE_MS : 0);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [enabled, jobInstance, initialized, version, timelineLabels, meta, attributeName]);

    return data;
}
