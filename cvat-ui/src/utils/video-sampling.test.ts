// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Run with: node --test cvat-ui/src/utils/video-sampling.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { FrameRange, SamplingVideoInfo } from './video-sampling.ts';
import {
    countOutputFrames, formValuesToRange, formatFps, formatTime, frameSeekTime, frameToSeconds, isFullRange,
    normalizeRange, rangeToFormValues, samplingPresets, samplingWarnings, secondsToFrame, stepForTargetFps,
    thumbnailFrames,
} from './video-sampling.ts';

const NTSC = 30000 / 1001;
const range = (startFrame: number, stopFrame: number, frameStep = 1): FrameRange => ({
    startFrame, stopFrame, frameStep,
});

// the same as len(range(start, stop + 1, step)) on the server
const serverCount = ({ startFrame, stopFrame, frameStep }: FrameRange): number => {
    let count = 0;
    for (let frame = startFrame; frame <= stopFrame; frame += frameStep) count++;
    return count;
};

const info = (overrides: Partial<SamplingVideoInfo> = {}): SamplingVideoInfo => ({
    fps: NTSC, frameCount: 1799, vfr: false, bitDepth: 8, editListOffsetFrames: 0, ...overrides,
});

describe('countOutputFrames', () => {
    it('matches the server formula', () => {
        assert.equal(countOutputFrames(range(0, 1798)), 1799);
        assert.equal(countOutputFrames(range(360, 1739, 3)), 460);
        assert.equal(countOutputFrames(range(5, 5, 10)), 1);

        for (const [start, stop, step] of [[0, 0, 1], [0, 9, 3], [1, 10, 3], [7, 100, 7], [0, 1798, 30], [3, 4, 5]]) {
            const r = range(start, stop, step);
            assert.equal(countOutputFrames(r), serverCount(r), JSON.stringify(r));
        }
    });

    it('an inverted range has no frames', () => {
        assert.equal(countOutputFrames(range(10, 5)), 0);
    });
});

describe('stepForTargetFps', () => {
    it('picks the closest integer step', () => {
        assert.equal(stepForTargetFps(NTSC, 15), 2);
        assert.equal(stepForTargetFps(NTSC, 10), 3);
        assert.equal(stepForTargetFps(NTSC, 5), 6);
        assert.equal(stepForTargetFps(NTSC, 1), 30);
        // 25 / 3 = 8.33 is closer to 10 than 25 / 2 = 12.5
        assert.equal(stepForTargetFps(25, 10), 3);
    });

    it('is never less than 1', () => {
        assert.equal(stepForTargetFps(10, 15), 1);
        assert.equal(stepForTargetFps(1, 30), 1);
    });
});

describe('samplingPresets', () => {
    it('lists all the frames first, then the target rates', () => {
        const presets = samplingPresets(NTSC);
        assert.deepEqual(presets.map((preset) => preset.step), [1, 2, 3, 6, 30]);
        assert.equal(presets[0].label, 'All (29.97 fps)');
        assert.equal(presets[2].label, '10 fps');
        assert.ok(Math.abs(presets[2].outputFps - 9.99) < 0.01);
    });

    it('does not repeat steps', () => {
        assert.deepEqual(samplingPresets(10).map((preset) => preset.step), [1, 2, 10]);
        const steps = samplingPresets(12).map((preset) => preset.step);
        assert.equal(new Set(steps).size, steps.length);
    });
});

describe('frame and time conversion', () => {
    it('round trips without losing frames at the edges', () => {
        for (const frame of [0, 1, 899, 1797, 1798]) {
            assert.equal(secondsToFrame(frameToSeconds(frame, NTSC), NTSC, 1799), frame);
            assert.equal(secondsToFrame(frameSeekTime(frame, NTSC), NTSC, 1799), frame);
        }
    });

    it('clamps to the video', () => {
        assert.equal(secondsToFrame(-1, NTSC, 1799), 0);
        assert.equal(secondsToFrame(1000, NTSC, 1799), 1798);
    });

    it('formats time', () => {
        assert.equal(formatTime(0), '0:00.00');
        assert.equal(formatTime(12.014), '0:12.01');
        assert.equal(formatTime(60.027), '1:00.03');
        assert.equal(formatTime(3725.5), '1:02:05.50');
        assert.equal(formatTime(59.999), '1:00.00');
    });

    it('formats fps', () => {
        assert.equal(formatFps(NTSC), '29.97');
        assert.equal(formatFps(25), '25');
        assert.equal(formatFps(NTSC / 3), '9.99');
    });
});

describe('range normalization and form values', () => {
    it('clamps, swaps and rounds', () => {
        assert.deepEqual(normalizeRange(range(-5, 5000, 0), 1799), range(0, 1798, 1));
        assert.deepEqual(normalizeRange(range(100, 50, 2.4), 1799), range(50, 100, 2));
        assert.deepEqual(normalizeRange(range(0, 10, NaN), 1799), range(0, 10, 1));
    });

    it('the full range has empty form fields', () => {
        assert.ok(isFullRange(range(0, 1798), 1799));
        assert.ok(!isFullRange(range(0, 1798, 2), 1799));
        assert.deepEqual(rangeToFormValues(range(0, 1798), 1799), {
            startFrame: undefined, stopFrame: undefined, frameStep: undefined,
        });
        assert.deepEqual(rangeToFormValues(range(360, 1739, 3), 1799), {
            startFrame: 360, stopFrame: 1739, frameStep: 3,
        });
    });

    it('reads form values, including strings and empty fields', () => {
        assert.deepEqual(formValuesToRange({}, 1799), range(0, 1798, 1));
        assert.deepEqual(formValuesToRange({ startFrame: '360', stopFrame: '', frameStep: '3' }, 1799),
            range(360, 1798, 3));
        assert.deepEqual(formValuesToRange({ startFrame: 'abc', stopFrame: 99999 }, 1799), range(0, 1798, 1));
    });

    it('form values round trip', () => {
        for (const r of [range(0, 1798), range(360, 1739, 3), range(0, 100, 1), range(10, 1798, 6)]) {
            assert.deepEqual(formValuesToRange(rangeToFormValues(r, 1799), 1799), r);
        }
    });
});

describe('thumbnailFrames', () => {
    it('spreads frames evenly inside the video', () => {
        assert.deepEqual(thumbnailFrames(100, 4), [12, 37, 62, 87]);
        const frames = thumbnailFrames(1799, 20);
        assert.equal(frames.length, 20);
        assert.ok(frames.every((frame, i) => frame >= 0 && frame < 1799 && (i === 0 || frame > frames[i - 1])));
    });

    it('never asks for more thumbnails than frames', () => {
        assert.deepEqual(thumbnailFrames(3, 10), [0, 1, 2]);
        assert.deepEqual(thumbnailFrames(0, 10), []);
    });
});

describe('samplingWarnings', () => {
    const keys = (videoInfo: SamplingVideoInfo, r: FrameRange): string[] => (
        samplingWarnings(videoInfo, r).map((warning) => warning.key)
    );

    it('no warnings for a typical clip', () => {
        assert.deepEqual(keys(info(), range(0, 1798, 3)), []);
    });

    it('warns about sparse sampling only when sampling', () => {
        assert.deepEqual(keys(info(), range(0, 1798, 30)), ['sparse']);
        assert.deepEqual(keys(info({ fps: 4 }), range(0, 1798, 1)), []);
    });

    it('warns about many frames, vfr, edit lists and high bit depth', () => {
        assert.deepEqual(keys(info({ frameCount: 5000 }), range(0, 4999)), ['many_frames']);
        assert.deepEqual(keys(info({ vfr: true }), range(0, 10)), ['vfr']);
        assert.deepEqual(keys(info({ editListOffsetFrames: 2 }), range(0, 10)), ['edit_list']);
        assert.deepEqual(keys(info({ bitDepth: 10 }), range(0, 10)), ['bit_depth']);
    });
});
