// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Run with: node --test cvat-ui/src/utils/mp4-info.test.ts
// Set MP4_INFO_SAMPLE=<path to a local video> to also compare a real video with ffprobe

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import type { Mp4VideoInfo } from './mp4-info.ts';
import { readMp4Info } from './mp4-info.ts';

const fixture = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/mp4/${name}`, import.meta.url));

const reads: [number, number][] = [];
const info = (buffer: Buffer): Promise<Mp4VideoInfo | null> => readMp4Info(buffer.length, async (start, end) => {
    reads.push([start, end]);
    return new Uint8Array(buffer.subarray(start, Math.min(end, buffer.length)));
});

const near = (actual: number, expected: number, epsilon = 0.01): void => {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not close to ${expected}`);
};

describe('readMp4Info', () => {
    it('reads an 8-bit H.264 video', async () => {
        const result = await info(fixture('cfr-8bit.mp4'));
        assert.ok(result);
        assert.equal(result.width, 64);
        assert.equal(result.height, 36);
        assert.equal(result.frameCount, 10);
        near(result.fps, 29.97);
        assert.equal(result.vfr, false);
        assert.equal(result.codec, 'avc1');
        assert.equal(result.codecName, 'H.264');
        assert.equal(result.profileName, 'High');
        assert.equal(result.bitDepth, 8);
        assert.match(result.codecString ?? '', /^avc1\.6400[0-9A-F]{2}$/);
        assert.equal(result.editListOffsetFrames, 0);
        near(result.durationSeconds, 10 / 29.97);
    });

    it('detects a 10-bit H.264 video', async () => {
        const result = await info(fixture('cfr-10bit.mp4'));
        assert.ok(result);
        assert.equal(result.profileName, 'High 10');
        assert.equal(result.bitDepth, 10);
        assert.match(result.codecString ?? '', /^avc1\.6E00[0-9A-F]{2}$/);
    });

    it('reads a video with "moov" at the beginning', async () => {
        const result = await info(fixture('faststart.mp4'));
        assert.ok(result);
        assert.equal(result.frameCount, 10);
        near(result.fps, 25);
    });

    it('reads a QuickTime file with B-frames without hiding frames', async () => {
        const result = await info(fixture('qt.mov'));
        assert.ok(result);
        assert.equal(result.frameCount, 10);
        assert.equal(result.editListOffsetFrames, 0);
        near(result.fps, 25);
    });

    it('reads a 10-bit HEVC video', async () => {
        const result = await info(fixture('hevc-10bit.mp4'));
        assert.ok(result);
        assert.equal(result.codec, 'hvc1');
        assert.equal(result.codecName, 'HEVC');
        assert.equal(result.profileName, 'Main 10');
        assert.equal(result.bitDepth, 10);
        assert.match(result.codecString ?? '', /^hvc1\.2\.4\.L\d+(\.[0-9A-F]+)*$/);
        near(result.fps, 24);
    });

    it('detects a variable frame rate', async () => {
        const result = await info(fixture('vfr.mp4'));
        assert.ok(result);
        assert.equal(result.vfr, true);
        assert.equal(result.frameCount, 10);
        near(result.fps, 150 / 7);
    });

    it('does not count frames hidden by an edit list', async () => {
        const result = await info(fixture('edit-list.mp4'));
        assert.ok(result);
        assert.equal(result.frameCount, 17);
        assert.equal(result.editListOffsetFrames, 13);
    });

    it('reads only headers and "moov", not the media data', async () => {
        const buffer = fixture('cfr-8bit.mp4');
        reads.length = 0;
        await info(buffer);
        const total = reads.reduce((acc, [start, end]) => acc + end - start, 0);
        assert.ok(total < buffer.length, `read ${total} bytes of ${buffer.length}`);
    });

    it('returns null for files that are not MP4', async () => {
        assert.equal(await info(Buffer.from('this is not a video at all, just some text')), null);
        assert.equal(await info(Buffer.alloc(0)), null);
        assert.equal(await info(fixture('README.md')), null);
    });

    it('returns null for truncated files without throwing', async () => {
        const buffer = fixture('faststart.mp4');
        for (const size of [8, 40, 200, 600]) {
            assert.equal(await info(buffer.subarray(0, size)), null, `size ${size}`);
        }
    });

    const sample = process.env.MP4_INFO_SAMPLE;
    it('matches ffprobe on a real video', { skip: !sample || !existsSync(sample) }, async () => {
        const probe = JSON.parse(execFileSync('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'stream=width,height,nb_frames,avg_frame_rate,profile', '-of', 'json', sample as string,
        ]).toString()).streams[0];
        const result = await info(readFileSync(sample as string));
        assert.ok(result);
        const [num, den] = probe.avg_frame_rate.split('/').map(Number);
        assert.equal(result.width, probe.width);
        assert.equal(result.height, probe.height);
        assert.equal(result.frameCount, +probe.nb_frames);
        assert.equal(result.profileName, probe.profile);
        near(result.fps, num / den);
    });
});
