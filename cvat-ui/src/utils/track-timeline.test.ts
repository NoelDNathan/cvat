// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Run with: node --test cvat-ui/src/utils/track-timeline.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TimelineKeyframe, TimelineRow, TimelineTrackInput } from './track-timeline.ts';
import {
    buildTimelineRows, computeSegments, filterRows, findSegment, frameToX, framesToRanges, isAliveAt,
    mergeSegments, nearestAliveFrame, rulerStep, segmentsInRange, sortRows, xToFrame,
} from './track-timeline.ts';

const visible = (frame: number): TimelineKeyframe => ({ frame, outside: false, occluded: false });
const outside = (frame: number): TimelineKeyframe => ({ frame, outside: true, occluded: false });
const occluded = (frame: number): TimelineKeyframe => ({ frame, outside: false, occluded: true });

const STOP = 299;

describe('computeSegments', () => {
    it('a single visible keyframe lasts until the end of the job', () => {
        assert.deepEqual(computeSegments([visible(10)], 0, STOP), [{ start: 10, stop: STOP, occluded: false }]);
    });

    it('an outside keyframe opens a gap', () => {
        assert.deepEqual(computeSegments([visible(0), outside(120), visible(140)], 0, STOP), [
            { start: 0, stop: 119, occluded: false },
            { start: 140, stop: STOP, occluded: false },
        ]);
    });

    it('the last outside keyframe ends the bar on the previous frame', () => {
        assert.deepEqual(computeSegments([visible(5), visible(50), outside(80)], 0, STOP), [
            { start: 5, stop: 79, occluded: false },
        ]);
    });

    it('occluded parts are separate segments, contiguous ones with the same state are merged', () => {
        assert.deepEqual(computeSegments([visible(0), visible(30), occluded(60), occluded(70), visible(90)], 0, STOP), [
            { start: 0, stop: 59, occluded: false },
            { start: 60, stop: 89, occluded: true },
            { start: 90, stop: STOP, occluded: false },
        ]);
    });

    it('clips to the job range, a keyframe before the job start defines the initial state', () => {
        assert.deepEqual(computeSegments([visible(50), outside(150), visible(400)], 100, 200), [
            { start: 100, stop: 149, occluded: false },
        ]);
        assert.deepEqual(computeSegments([outside(50), visible(150)], 100, 200), [
            { start: 150, stop: 200, occluded: false },
        ]);
        assert.deepEqual(computeSegments([visible(250)], 100, 200), []);
    });

    it('a track that is always outside has no segments', () => {
        assert.deepEqual(computeSegments([outside(0), outside(40)], 0, STOP), []);
        const [row] = buildTimelineRows([{ clientID: 1, label_id: 1, shapes: [outside(0)] }], [], 0, STOP);
        assert.equal(row.firstFrame, null);
        assert.equal(row.lastFrame, null);
    });

    it('does not depend on the keyframes order', () => {
        const keyframes = [visible(0), outside(120), occluded(140), visible(200)];
        const shuffled = [keyframes[2], keyframes[0], keyframes[3], keyframes[1]];
        assert.deepEqual(computeSegments(shuffled, 0, STOP), computeSegments(keyframes, 0, STOP));
    });
});

describe('skeletons', () => {
    it('a skeleton is the union of its elements', () => {
        const track: TimelineTrackInput = {
            clientID: 7,
            label_id: 1,
            shapes: [],
            elements: [
                { label_id: 2, shapes: [visible(0), outside(50)] },
                { label_id: 3, shapes: [visible(30), outside(100), visible(200)] },
            ],
        };
        const [row] = buildTimelineRows([track], [], 0, STOP);
        assert.deepEqual(row.segments, [
            { start: 0, stop: 99, occluded: false },
            { start: 200, stop: STOP, occluded: false },
        ]);
        assert.deepEqual(row.keyframes, [0, 30, 50, 100, 200]);
        assert.equal(row.firstFrame, 0);
        assert.equal(row.lastFrame, STOP);
    });

    it('a skeleton is occluded only where all visible elements are occluded', () => {
        assert.deepEqual(mergeSegments([
            [{ start: 0, stop: 49, occluded: true }],
            [{ start: 20, stop: 29, occluded: false }],
        ]), [
            { start: 0, stop: 19, occluded: true },
            { start: 20, stop: 29, occluded: false },
            { start: 30, stop: 49, occluded: true },
        ]);
    });
});

describe('lookups', () => {
    const segments = computeSegments([visible(10), outside(20), visible(40), outside(50)], 0, STOP);

    it('isAliveAt on boundaries', () => {
        assert.equal(isAliveAt(segments, 9), false);
        assert.equal(isAliveAt(segments, 10), true);
        assert.equal(isAliveAt(segments, 19), true);
        assert.equal(isAliveAt(segments, 20), false);
        assert.equal(isAliveAt(segments, 40), true);
        assert.equal(isAliveAt(segments, 49), true);
        assert.equal(isAliveAt(segments, 50), false);
        assert.equal(isAliveAt([], 0), false);
        assert.equal(findSegment(segments, 45), 1);
    });

    it('nearestAliveFrame prefers the current frame, then the next segment, then the previous one', () => {
        assert.equal(nearestAliveFrame(segments, 0), 10);
        assert.equal(nearestAliveFrame(segments, 15), 15);
        assert.equal(nearestAliveFrame(segments, 25), 40);
        assert.equal(nearestAliveFrame(segments, 49), 49);
        assert.equal(nearestAliveFrame(segments, 100), 40);
        assert.equal(nearestAliveFrame([], 100), null);
    });

    it('segmentsInRange', () => {
        assert.deepEqual(segmentsInRange(segments, 0, 9), []);
        assert.deepEqual(segmentsInRange(segments, 19, 40), segments);
        assert.deepEqual(segmentsInRange(segments, 20, 39), []);
        assert.deepEqual(segmentsInRange(segments, 45, 1000), [segments[1]]);
    });
});

describe('rows', () => {
    const labels = [
        { id: 1, name: 'player', color: '#ff0000', attributes: [{ id: 11, name: 'number' }] },
        { id: 2, name: 'ball', color: '#00ff00' },
    ];
    const tracks: TimelineTrackInput[] = [
        {
            clientID: 3, id: 30, label_id: 1, shapes: [visible(50)], attributes: [{ spec_id: 11, value: '10' }],
        },
        { clientID: 1, label_id: 2, shapes: [visible(50)] },
        { clientID: 2, label_id: 1, shapes: [visible(0)] },
        { clientID: 4, label_id: 2, shapes: [outside(0)] },
    ];

    it('buildTimelineRows fills labels, colors and attribute values', () => {
        const rows = buildTimelineRows(tracks, labels, 0, STOP, 'number');
        assert.equal(rows.length, 4);
        assert.equal(rows[0].labelName, 'player');
        assert.equal(rows[0].color, '#ff0000');
        assert.equal(rows[0].serverID, 30);
        assert.equal(rows[0].attributeValue, '10');
        assert.equal(rows[1].serverID, null);
        assert.equal(rows[1].attributeValue, undefined);
    });

    it('sortRows is stable in all the modes', () => {
        const rows = buildTimelineRows(tracks, labels, 0, STOP);
        const ids = (sorted: TimelineRow[]): number[] => sorted.map((row) => row.clientID);
        assert.deepEqual(ids(sortRows(rows, 'first_appearance')), [2, 1, 3, 4]);
        assert.deepEqual(ids(sortRows(rows, 'id')), [1, 2, 3, 4]);
        assert.deepEqual(ids(sortRows(rows, 'label')), [1, 4, 2, 3]);
        assert.deepEqual(ids(sortRows(sortRows(rows, 'label'), 'label')), [1, 4, 2, 3]);
        assert.deepEqual(ids(rows), [3, 1, 2, 4], 'the input is not mutated');
    });

    it('filterRows by id, label, attribute and visibility', () => {
        const rows = buildTimelineRows(tracks, labels, 0, STOP, 'number');
        const ids = (filtered: TimelineRow[]): number[] => filtered.map((row) => row.clientID);
        assert.deepEqual(ids(filterRows(rows, '')), [3, 1, 2, 4]);
        assert.deepEqual(ids(filterRows(rows, '#1')), [1]);
        assert.deepEqual(ids(filterRows(rows, 'BALL')), [1, 4]);
        assert.deepEqual(ids(filterRows(rows, '10')), [3]);
        assert.deepEqual(ids(filterRows(rows, '', 10)), [2]);
        assert.deepEqual(ids(filterRows(rows, 'player', 60)), [3, 2]);
    });
});

describe('scale', () => {
    it('rulerStep is monotonic', () => {
        let previous = Infinity;
        for (let px = 0.01; px <= 64; px *= 1.3) {
            const step = rulerStep(px);
            assert.ok(step <= previous, `step ${step} at ${px}px per frame`);
            assert.ok(step * px >= 64 || step === 100000);
            previous = step;
        }
        assert.equal(rulerStep(64), 1);
        assert.equal(rulerStep(10), 10);
    });

    it('frameToX and xToFrame are consistent', () => {
        const scale = { startFrame: 100, pxPerFrame: 2.5, offset: 40 };
        for (let frame = 100; frame < 200; frame++) {
            const x = frameToX(frame, scale);
            assert.equal(xToFrame(x, scale), frame);
            assert.equal(xToFrame(x + 2.4, scale), frame);
        }
    });

    it('framesToRanges', () => {
        assert.deepEqual(framesToRanges([7, 1, 3, 2, 2]), [{ start: 1, stop: 3 }, { start: 7, stop: 7 }]);
        assert.deepEqual(framesToRanges([]), []);
    });
});
