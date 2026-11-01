// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useEffect, useLayoutEffect, useRef, useState,
} from 'react';

import { Chapter } from 'cvat-core/src/frames';
import { clamp } from 'utils/math';
import {
    TimelineRange, TimelineRow, TimelineScale,
    frameToX, isAliveAt, keyframesInRange, rulerStep, segmentsInRange, xToFrame,
} from 'utils/track-timeline';

export const LABELS_WIDTH = 180;
const RULER_HEIGHT = 24;
const ROW_HEIGHT = 20;
const BAR_HEIGHT = 12;
const MIN_KEYFRAME_GAP = 6;
const KEYFRAME_HIT_RADIUS = 5;
const MAX_ZOOM = 64;
// px per frame reachable at the maximum zoom on long jobs
const MAX_ZOOM_PX_PER_FRAME = 16;
const EXTRA_RENDERED_ROWS = 2;

interface Props {
    rows: TimelineRow[];
    deletedRanges: TimelineRange[];
    chapters: Chapter[];
    startFrame: number;
    stopFrame: number;
    frame: number;
    playing: boolean;
    activatedStateID: number | null;
    onJump(frame: number, clientID: number | null): void;
    onHoverRow(row: TimelineRow): void;
    onLabelClick(row: TimelineRow): void;
}

interface View {
    zoom: number;
    // horizontal scroll in pixels
    offset: number;
}

function describeRow(row: TimelineRow): string {
    const segments = row.segments.map((segment) => (
        `${segment.start}–${segment.stop}${segment.occluded ? ' (occluded)' : ''}`
    ));
    const title = `#${row.clientID} ${row.labelName}${row.attributeValue ? ` · ${row.attributeValue}` : ''}`;
    return `${title}\n${segments.length ? segments.join('\n') : 'Never visible'}`;
}

function visibleKeyframes(row: TimelineRow, scale: TimelineScale, from: number, to: number): number[] {
    const keyframes = keyframesInRange(row.keyframes, from, to);
    for (let i = 1; i < keyframes.length; i++) {
        if ((keyframes[i] - keyframes[i - 1]) * scale.pxPerFrame < MIN_KEYFRAME_GAP) {
            return [];
        }
    }

    return keyframes;
}

interface RowProps {
    row: TimelineRow;
    index: number;
    width: number;
    startFrame: number;
    pxPerFrame: number;
    offset: number;
    active: boolean;
    hovered: boolean;
}

function TimelineRowComponent({
    row, index, width, startFrame, pxPerFrame, offset, active, hovered,
}: RowProps): JSX.Element {
    const scale = { startFrame, pxPerFrame, offset };
    const from = xToFrame(0, scale);
    const to = xToFrame(width, scale);
    const top = index * ROW_HEIGHT;
    const barTop = top + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    const keyframes = visibleKeyframes(row, scale, from, to);

    let className = 'cvat-track-timeline-row';
    if (active) className += ' cvat-track-timeline-row-active';
    if (hovered) className += ' cvat-track-timeline-row-hovered';

    return (
        <g className={className}>
            <title>{describeRow(row)}</title>
            <rect className='cvat-track-timeline-row-background' x={0} y={top} width={width} height={ROW_HEIGHT} />
            {segmentsInRange(row.segments, from, to).map((segment) => {
                const x = Math.max(frameToX(segment.start, scale), -1);
                const right = Math.min(frameToX(segment.stop + 1, scale), width + 1);
                const barWidth = Math.max(right - x, 1);
                const radius = barWidth > 6 ? 3 : 0;
                return (
                    <React.Fragment key={segment.start}>
                        <rect
                            className='cvat-track-timeline-bar'
                            x={x}
                            y={barTop}
                            width={barWidth}
                            height={BAR_HEIGHT}
                            rx={radius}
                            fill={row.color}
                            fillOpacity={segment.occluded ? 0.45 : 1}
                        />
                        {segment.occluded && (
                            <rect
                                className='cvat-track-timeline-bar-occluded'
                                x={x}
                                y={barTop}
                                width={barWidth}
                                height={BAR_HEIGHT}
                                rx={radius}
                                fill='url(#cvat-track-timeline-hatch)'
                            />
                        )}
                    </React.Fragment>
                );
            })}
            {keyframes.map((keyframe) => {
                const x = frameToX(keyframe, scale) + pxPerFrame / 2;
                const y = top + ROW_HEIGHT / 2;
                return (
                    <path
                        key={keyframe}
                        className='cvat-track-timeline-keyframe'
                        d={`M ${x} ${y - 4} L ${x + 4} ${y} L ${x} ${y + 4} L ${x - 4} ${y} Z`}
                    />
                );
            })}
        </g>
    );
}

const TimelineRowView = React.memo(TimelineRowComponent);

function TimelineRuler(props: {
    width: number;
    scale: TimelineScale;
    startFrame: number;
    stopFrame: number;
    frame: number;
    chapters: Chapter[];
    onJump(frame: number): void;
}): JSX.Element {
    const {
        width, scale, startFrame, stopFrame, frame, chapters, onJump,
    } = props;
    const from = Math.max(xToFrame(0, scale), startFrame);
    const to = Math.min(xToFrame(width, scale), stopFrame);
    const step = rulerStep(scale.pxPerFrame);
    const minorStep = step >= 5 ? step / 5 : null;

    const ticks: JSX.Element[] = [];
    if (minorStep !== null && minorStep * scale.pxPerFrame >= 4) {
        for (let tick = Math.ceil(from / minorStep) * minorStep; tick <= to; tick += minorStep) {
            if (tick % step !== 0) {
                const x = frameToX(tick, scale);
                ticks.push(
                    <line
                        key={`minor_${tick}`}
                        className='cvat-track-timeline-tick-minor'
                        x1={x}
                        x2={x}
                        y1={19}
                        y2={RULER_HEIGHT}
                    />,
                );
            }
        }
    }
    for (let tick = Math.ceil(from / step) * step; tick <= to; tick += step) {
        const x = frameToX(tick, scale);
        ticks.push(
            <g key={tick}>
                <line className='cvat-track-timeline-tick' x1={x} x2={x} y1={14} y2={RULER_HEIGHT} />
                <text className='cvat-track-timeline-tick-label' x={x + 3} y={16}>{tick}</text>
            </g>,
        );
    }

    const playheadX = frameToX(frame, scale) + scale.pxPerFrame / 2;
    return (
        <svg
            className='cvat-track-timeline-ruler'
            width={width}
            height={RULER_HEIGHT}
            onClick={(event: React.MouseEvent<SVGSVGElement>) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onJump(xToFrame(event.clientX - rect.left, scale));
            }}
        >
            {chapters.filter((chapter) => chapter.stop >= from && chapter.start <= to).map((chapter, idx) => {
                const x = frameToX(chapter.start, scale);
                return (
                    <rect
                        key={chapter.id}
                        className={`cvat-track-timeline-chapter cvat-track-timeline-chapter-${idx % 2}`}
                        x={x}
                        y={0}
                        width={Math.max(frameToX(chapter.stop + 1, scale) - x, 1)}
                        height={5}
                    >
                        <title>{chapter.metadata?.title || `Chapter ${chapter.id}`}</title>
                    </rect>
                );
            })}
            {ticks}
            <path
                className='cvat-track-timeline-playhead-head'
                d={`M ${playheadX - 5} 6 L ${playheadX + 5} 6 L ${playheadX} 13 Z`}
            />
            <line className='cvat-track-timeline-playhead' x1={playheadX} x2={playheadX} y1={6} y2={RULER_HEIGHT} />
        </svg>
    );
}

function TimelineCanvas(props: Props): JSX.Element {
    const {
        rows, deletedRanges, chapters, startFrame, stopFrame, frame, playing, activatedStateID,
        onJump, onHoverRow, onLabelClick,
    } = props;

    const bodyRef = useRef<HTMLDivElement>(null);
    const rowsScrollRef = useRef<HTMLDivElement>(null);
    const horizontalScrollRef = useRef<HTMLDivElement>(null);
    const activatedFromTimeline = useRef<number | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [scrollTop, setScrollTop] = useState(0);
    const [view, setView] = useState<View>({ zoom: 1, offset: 0 });
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const totalFrames = stopFrame - startFrame + 1;
    const basePxPerFrame = size.width > 0 ? size.width / totalFrames : 1;
    const maxZoom = Math.max(MAX_ZOOM, MAX_ZOOM_PX_PER_FRAME / basePxPerFrame);
    const pxPerFrame = basePxPerFrame * view.zoom;
    const contentWidth = totalFrames * pxPerFrame;
    const maxOffset = Math.max(contentWidth - size.width, 0);
    const offset = clamp(view.offset, 0, maxOffset);
    const scale: TimelineScale = { startFrame, pxPerFrame, offset };

    // the latest geometry for native event listeners
    const geometry = useRef({ basePxPerFrame, maxZoom, totalFrames });
    geometry.current = { basePxPerFrame, maxZoom, totalFrames };

    useLayoutEffect(() => {
        const element = rowsScrollRef.current;
        if (!element) return () => {};

        const updateSize = (): void => {
            setSize({ width: Math.max(element.clientWidth - LABELS_WIDTH, 0), height: element.clientHeight });
        };
        const observer = new ResizeObserver(updateSize);
        observer.observe(element);
        updateSize();
        return () => observer.disconnect();
    }, []);

    // ctrl + wheel zooms around the cursor, shift + wheel scrolls horizontally, wheel scrolls rows natively
    useEffect(() => {
        const element = bodyRef.current;
        if (!element) return () => {};

        const onWheel = (event: WheelEvent): void => {
            const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
            if (!event.ctrlKey && !horizontal) {
                return;
            }

            event.preventDefault();
            const { basePxPerFrame: base, maxZoom: max, totalFrames: frames } = geometry.current;
            const areaWidth = element.clientWidth - LABELS_WIDTH;
            setView((current) => {
                const currentPx = base * current.zoom;
                const currentOffset = clamp(current.offset, 0, Math.max(frames * currentPx - areaWidth, 0));
                if (event.ctrlKey) {
                    const { left } = element.getBoundingClientRect();
                    const anchor = clamp(event.clientX - left - LABELS_WIDTH, 0, areaWidth);
                    const zoom = clamp(current.zoom * (event.deltaY < 0 ? 1.25 : 0.8), 1, max);
                    const px = base * zoom;
                    const anchoredFrame = (anchor + currentOffset) / currentPx;
                    return {
                        zoom,
                        offset: clamp(anchoredFrame * px - anchor, 0, Math.max(frames * px - areaWidth, 0)),
                    };
                }

                const delta = event.deltaX || event.deltaY;
                return {
                    ...current,
                    offset: clamp(currentOffset + delta, 0, Math.max(frames * currentPx - areaWidth, 0)),
                };
            });
        };

        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, []);

    // keep the native horizontal scrollbar in sync with the view
    useEffect(() => {
        const element = horizontalScrollRef.current;
        if (element && Math.abs(element.scrollLeft - offset) > 1) {
            element.scrollLeft = offset;
        }
    }, [offset, contentWidth]);

    // follow the playhead during playback
    useEffect(() => {
        if (!playing || size.width <= 0) return;
        const x = frameToX(frame, scale);
        if (x < 0 || x + pxPerFrame > size.width) {
            setView((current) => ({ ...current, offset: (frame - startFrame) * pxPerFrame - size.width * 0.1 }));
        }
    }, [frame, playing]);

    // scroll to the row activated outside of the timeline
    useEffect(() => {
        const element = rowsScrollRef.current;
        if (activatedStateID === null || !element || activatedFromTimeline.current === activatedStateID) {
            return;
        }

        const index = rows.findIndex((row) => row.clientID === activatedStateID);
        if (index === -1) return;
        const top = index * ROW_HEIGHT;
        if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
            element.scrollTop = top - element.clientHeight / 2 + ROW_HEIGHT / 2;
        }
    }, [activatedStateID]);

    useEffect(() => {
        if (activatedStateID !== activatedFromTimeline.current) {
            activatedFromTimeline.current = null;
        }
    }, [activatedStateID]);

    const locate = (event: React.MouseEvent<SVGSVGElement>): {
        row: TimelineRow | null; index: number; x: number; frame: number;
    } => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const index = Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
        return {
            row: rows[index] ?? null,
            index,
            x,
            frame: clamp(xToFrame(x, scale), startFrame, stopFrame),
        };
    };

    const jumpAndActivate = (toFrame: number, row: TimelineRow): void => {
        activatedFromTimeline.current = row.clientID;
        onJump(toFrame, row.clientID);
    };

    const onRowsClick = (event: React.MouseEvent<SVGSVGElement>): void => {
        const { row, x, frame: targetFrame } = locate(event);
        if (!row) {
            onJump(targetFrame, null);
            return;
        }

        const from = xToFrame(0, scale);
        const to = xToFrame(size.width, scale);
        const keyframe = visibleKeyframes(row, scale, from, to).find((_keyframe) => (
            Math.abs(frameToX(_keyframe, scale) + pxPerFrame / 2 - x) <= KEYFRAME_HIT_RADIUS
        ));
        if (typeof keyframe === 'number' && isAliveAt(row.segments, keyframe)) {
            jumpAndActivate(keyframe, row);
        } else if (isAliveAt(row.segments, targetFrame)) {
            jumpAndActivate(targetFrame, row);
        } else {
            onJump(typeof keyframe === 'number' ? keyframe : targetFrame, null);
        }
    };

    const onRowHover = (row: TimelineRow | null, index: number | null): void => {
        if (index === hoveredIndex) return;
        setHoveredIndex(index);
        if (row) {
            activatedFromTimeline.current = row.clientID;
            onHoverRow(row);
        }
    };

    const firstRow = Math.max(Math.floor(scrollTop / ROW_HEIGHT) - EXTRA_RENDERED_ROWS, 0);
    const lastRow = Math.min(
        Math.ceil((scrollTop + size.height) / ROW_HEIGHT) + EXTRA_RENDERED_ROWS,
        rows.length,
    );
    const visibleRows = rows.slice(firstRow, lastRow);
    const rowsHeight = rows.length * ROW_HEIGHT;
    const playheadX = frameToX(frame, scale) + pxPerFrame / 2;
    const visibleFrom = xToFrame(0, scale);
    const visibleTo = xToFrame(size.width, scale);

    return (
        <div className='cvat-track-timeline-body' ref={bodyRef}>
            <div className='cvat-track-timeline-ruler-wrapper'>
                <div className='cvat-track-timeline-ruler-spacer' style={{ width: LABELS_WIDTH }} />
                {size.width > 0 && (
                    <TimelineRuler
                        width={size.width}
                        scale={scale}
                        startFrame={startFrame}
                        stopFrame={stopFrame}
                        frame={frame}
                        chapters={chapters}
                        onJump={(targetFrame: number) => onJump(clamp(targetFrame, startFrame, stopFrame), null)}
                    />
                )}
            </div>
            <div
                className='cvat-track-timeline-rows-scroll'
                ref={rowsScrollRef}
                onScroll={(event: React.UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
            >
                <div
                    className='cvat-track-timeline-rows'
                    style={{ height: Math.max(rowsHeight, 1) }}
                    onMouseLeave={() => setHoveredIndex(null)}
                >
                    <div className='cvat-track-timeline-labels' style={{ width: LABELS_WIDTH }}>
                        {visibleRows.map((row, idx) => {
                            const index = firstRow + idx;
                            let className = 'cvat-track-timeline-label';
                            if (row.clientID === activatedStateID) className += ' cvat-track-timeline-row-active';
                            if (index === hoveredIndex) className += ' cvat-track-timeline-row-hovered';
                            if (!isAliveAt(row.segments, frame)) className += ' cvat-track-timeline-label-hidden';
                            return (
                                <div
                                    key={row.clientID}
                                    role='button'
                                    tabIndex={-1}
                                    className={className}
                                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                                    title={describeRow(row)}
                                    onClick={() => {
                                        activatedFromTimeline.current = row.clientID;
                                        onLabelClick(row);
                                    }}
                                    onKeyDown={() => {}}
                                    onMouseEnter={() => onRowHover(row, index)}
                                >
                                    <span
                                        className='cvat-track-timeline-label-color'
                                        style={{ background: row.color }}
                                    />
                                    <span className='cvat-track-timeline-label-id'>{`#${row.clientID}`}</span>
                                    <span className='cvat-track-timeline-label-name'>
                                        {row.labelName}
                                        {row.attributeValue ? ` · ${row.attributeValue}` : ''}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    {size.width > 0 && (
                        <svg
                            className='cvat-track-timeline-rows-svg'
                            width={size.width}
                            height={Math.max(rowsHeight, 1)}
                            onClick={onRowsClick}
                            onMouseMove={(event: React.MouseEvent<SVGSVGElement>) => {
                                const { row, index } = locate(event);
                                onRowHover(row, row ? index : null);
                            }}
                        >
                            <defs>
                                <pattern
                                    id='cvat-track-timeline-hatch'
                                    width={6}
                                    height={6}
                                    patternUnits='userSpaceOnUse'
                                    patternTransform='rotate(45)'
                                >
                                    <rect width={3} height={6} fill='white' fillOpacity={0.6} />
                                </pattern>
                            </defs>
                            {deletedRanges.filter((range) => range.stop >= visibleFrom && range.start <= visibleTo)
                                .map((range) => {
                                    const x = frameToX(range.start, scale);
                                    return (
                                        <rect
                                            key={range.start}
                                            className='cvat-track-timeline-deleted-frames'
                                            x={x}
                                            y={0}
                                            width={Math.max(frameToX(range.stop + 1, scale) - x, 1)}
                                            height={rowsHeight}
                                        />
                                    );
                                })}
                            {visibleRows.map((row, idx) => (
                                <TimelineRowView
                                    key={row.clientID}
                                    row={row}
                                    index={firstRow + idx}
                                    width={size.width}
                                    startFrame={startFrame}
                                    pxPerFrame={pxPerFrame}
                                    offset={offset}
                                    active={row.clientID === activatedStateID}
                                    hovered={firstRow + idx === hoveredIndex}
                                />
                            ))}
                            <line
                                className='cvat-track-timeline-playhead'
                                x1={playheadX}
                                x2={playheadX}
                                y1={0}
                                y2={rowsHeight}
                            />
                        </svg>
                    )}
                </div>
            </div>
            <div
                className='cvat-track-timeline-horizontal-scroll'
                ref={horizontalScrollRef}
                style={{ marginLeft: LABELS_WIDTH, width: size.width }}
                onScroll={(event: React.UIEvent<HTMLDivElement>) => {
                    const { scrollLeft } = event.currentTarget;
                    if (Math.abs(scrollLeft - offset) > 1) {
                        setView((current) => ({ ...current, offset: scrollLeft }));
                    }
                }}
            >
                <div style={{ width: contentWidth, height: 1 }} />
            </div>
        </div>
    );
}

export default React.memo(TimelineCanvas);
