// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Pure logic of the track timeline panel.
// The file intentionally has no imports and no enums, so it can be tested with plain Node (type stripping).

export interface TimelineKeyframe {
    frame: number;
    outside: boolean;
    occluded: boolean;
}

// both start and stop are inclusive
export interface TimelineSegment {
    start: number;
    stop: number;
    occluded: boolean;
}

export interface TimelineRange {
    start: number;
    stop: number;
}

export interface TimelineRow {
    clientID: number;
    serverID: number | null;
    labelID: number;
    labelName: string;
    color: string;
    // sorted, not overlapped, contiguous segments with the same "occluded" are merged
    segments: TimelineSegment[];
    keyframes: number[];
    // null if the object is never visible within the job
    firstFrame: number | null;
    lastFrame: number | null;
    attributeValue?: string;
}

export type TimelineSortMode = 'first_appearance' | 'id' | 'label';

// structural subset of SerializedTrack from cvat-core
export interface TimelineTrackInput {
    id?: number;
    clientID?: number;
    label_id: number;
    attributes?: { spec_id: number; value: string }[];
    shapes: TimelineKeyframe[];
    elements?: Omit<TimelineTrackInput, 'elements'>[];
}

export interface TimelineLabelInput {
    id: number;
    name: string;
    color: string;
    attributes?: { id: number; name: string }[];
}

export interface TimelineScale {
    startFrame: number;
    pxPerFrame: number;
    // horizontal scroll in pixels
    offset: number;
}

const DEFAULT_COLOR = '#b0bec5';
const RULER_STEPS = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000];

function pushSegment(segments: TimelineSegment[], segment: TimelineSegment): void {
    const last = segments[segments.length - 1];
    if (last && last.stop + 1 >= segment.start && last.occluded === segment.occluded) {
        last.stop = Math.max(last.stop, segment.stop);
    } else {
        segments.push(segment);
    }
}

// the state of a track between two keyframes is defined by the left keyframe (see cvat-core track interpolation)
export function computeSegments(
    keyframes: TimelineKeyframe[],
    startFrame: number,
    stopFrame: number,
): TimelineSegment[] {
    const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
    const segments: TimelineSegment[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const keyframe = sorted[i];
        const next = sorted[i + 1];
        if (next && next.frame === keyframe.frame) {
            continue;
        }

        if (!keyframe.outside) {
            const start = Math.max(keyframe.frame, startFrame);
            const stop = Math.min(next ? next.frame - 1 : stopFrame, stopFrame);
            if (start <= stop) {
                pushSegment(segments, { start, stop, occluded: keyframe.occluded });
            }
        }
    }

    return segments;
}

// union of segments, used for skeletons: visible if any element is visible,
// occluded only if all visible elements are occluded
export function mergeSegments(lists: TimelineSegment[][]): TimelineSegment[] {
    const deltas = new Map<number, { alive: number; visible: number }>();
    const addDelta = (frame: number, alive: number, visible: number): void => {
        const delta = deltas.get(frame) ?? { alive: 0, visible: 0 };
        delta.alive += alive;
        delta.visible += visible;
        deltas.set(frame, delta);
    };

    for (const list of lists) {
        for (const segment of list) {
            const visible = segment.occluded ? 0 : 1;
            addDelta(segment.start, 1, visible);
            addDelta(segment.stop + 1, -1, -visible);
        }
    }

    const points = [...deltas.keys()].sort((a, b) => a - b);
    const segments: TimelineSegment[] = [];
    let alive = 0;
    let visible = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const delta = deltas.get(points[i]) as { alive: number; visible: number };
        alive += delta.alive;
        visible += delta.visible;
        if (alive > 0) {
            pushSegment(segments, { start: points[i], stop: points[i + 1] - 1, occluded: visible === 0 });
        }
    }

    return segments;
}

// index of the segment containing the frame, or -1
export function findSegment(segments: TimelineSegment[], frame: number): number {
    let left = 0;
    let right = segments.length - 1;
    while (left <= right) {
        const middle = (left + right) >> 1;
        const segment = segments[middle];
        if (frame < segment.start) {
            right = middle - 1;
        } else if (frame > segment.stop) {
            left = middle + 1;
        } else {
            return middle;
        }
    }

    return -1;
}

export function isAliveAt(segments: TimelineSegment[], frame: number): boolean {
    return findSegment(segments, frame) !== -1;
}

// the frame itself if the object is visible there,
// otherwise the start of the next visible segment, otherwise the start of the previous one
export function nearestAliveFrame(segments: TimelineSegment[], frame: number): number | null {
    if (!segments.length) {
        return null;
    }

    if (isAliveAt(segments, frame)) {
        return frame;
    }

    const next = segments.find((segment) => segment.start > frame);
    if (next) {
        return next.start;
    }

    return segments[segments.length - 1].start;
}

// segments intersecting [from, to], found with binary search
export function segmentsInRange(segments: TimelineSegment[], from: number, to: number): TimelineSegment[] {
    let left = 0;
    let right = segments.length;
    while (left < right) {
        const middle = (left + right) >> 1;
        if (segments[middle].stop < from) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    const result: TimelineSegment[] = [];
    for (let i = left; i < segments.length && segments[i].start <= to; i++) {
        result.push(segments[i]);
    }

    return result;
}

function uniqueSortedFrames(frames: number[], startFrame: number, stopFrame: number): number[] {
    return [...new Set(frames)]
        .filter((frame) => frame >= startFrame && frame <= stopFrame)
        .sort((a, b) => a - b);
}

export function buildTimelineRows(
    tracks: TimelineTrackInput[],
    labels: TimelineLabelInput[],
    startFrame: number,
    stopFrame: number,
    attributeName: string | null = null,
): TimelineRow[] {
    const labelsByID = new Map(labels.map((label) => [label.id, label]));
    const rows: TimelineRow[] = [];

    for (const track of tracks) {
        if (typeof track.clientID !== 'number') {
            continue;
        }

        const label = labelsByID.get(track.label_id);
        const elements = track.elements ?? [];
        let segments: TimelineSegment[] = [];
        let keyframes: number[] = track.shapes.map((shape) => shape.frame);
        if (elements.length) {
            // skeleton visibility is defined by its elements
            segments = mergeSegments(elements.map((element) => (
                computeSegments(element.shapes, startFrame, stopFrame)
            )));
            for (const element of elements) {
                keyframes = keyframes.concat(element.shapes.map((shape) => shape.frame));
            }
        } else {
            segments = computeSegments(track.shapes, startFrame, stopFrame);
        }

        const row: TimelineRow = {
            clientID: track.clientID,
            serverID: track.id ?? null,
            labelID: track.label_id,
            labelName: label?.name ?? `#${track.label_id}`,
            color: label?.color || DEFAULT_COLOR,
            segments,
            keyframes: uniqueSortedFrames(keyframes, startFrame, stopFrame),
            firstFrame: segments.length ? segments[0].start : null,
            lastFrame: segments.length ? segments[segments.length - 1].stop : null,
        };

        if (attributeName !== null) {
            const spec = label?.attributes?.find((attribute) => attribute.name === attributeName);
            const value = spec ? track.attributes?.find((attribute) => attribute.spec_id === spec.id) : undefined;
            if (value) {
                row.attributeValue = value.value;
            }
        }

        rows.push(row);
    }

    return rows;
}

export function sortRows(rows: TimelineRow[], mode: TimelineSortMode): TimelineRow[] {
    const byID = (a: TimelineRow, b: TimelineRow): number => a.clientID - b.clientID;
    const byFirstFrame = (a: TimelineRow, b: TimelineRow): number => {
        if (a.firstFrame === b.firstFrame) return 0;
        if (a.firstFrame === null) return 1;
        if (b.firstFrame === null) return -1;
        return a.firstFrame - b.firstFrame;
    };

    const sorted = [...rows];
    if (mode === 'id') {
        sorted.sort(byID);
    } else if (mode === 'label') {
        sorted.sort((a, b) => a.labelName.localeCompare(b.labelName) || byFirstFrame(a, b) || byID(a, b));
    } else {
        sorted.sort((a, b) => byFirstFrame(a, b) || byID(a, b));
    }

    return sorted;
}

// "#12" matches the object 12 only, "12" matches the object 12 or labels/attribute values containing "12",
// any other text matches labels and attribute values
export function filterRows(rows: TimelineRow[], query: string, aliveAtFrame: number | null = null): TimelineRow[] {
    const text = query.trim().toLowerCase();
    return rows.filter((row) => {
        if (aliveAtFrame !== null && !isAliveAt(row.segments, aliveAtFrame)) {
            return false;
        }

        if (!text) {
            return true;
        }

        if (text.startsWith('#')) {
            return `${row.clientID}` === text.slice(1);
        }

        return `${row.clientID}` === text ||
            row.labelName.toLowerCase().includes(text) ||
            (row.attributeValue ?? '').toLowerCase().includes(text);
    });
}

// the smallest step from the list that keeps labeled ticks at least minTickPx apart
export function rulerStep(pxPerFrame: number, minTickPx = 64): number {
    for (const step of RULER_STEPS) {
        if (step * pxPerFrame >= minTickPx) {
            return step;
        }
    }

    return RULER_STEPS[RULER_STEPS.length - 1];
}

// left edge of the frame; a frame occupies [frameToX(frame), frameToX(frame + 1))
export function frameToX(frame: number, scale: TimelineScale): number {
    return (frame - scale.startFrame) * scale.pxPerFrame - scale.offset;
}

export function xToFrame(x: number, scale: TimelineScale): number {
    return scale.startFrame + Math.floor((x + scale.offset) / scale.pxPerFrame);
}

// [1, 2, 3, 7] => [{ start: 1, stop: 3 }, { start: 7, stop: 7 }]
export function framesToRanges(frames: number[]): TimelineRange[] {
    const sorted = [...new Set(frames)].sort((a, b) => a - b);
    const ranges: TimelineRange[] = [];
    for (const frame of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && last.stop + 1 === frame) {
            last.stop = frame;
        } else {
            ranges.push({ start: frame, stop: frame });
        }
    }

    return ranges;
}
