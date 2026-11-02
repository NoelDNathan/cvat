// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Pure logic of the video sampling block on the task creation page.
// The file intentionally has no imports and no enums, so it can be tested with plain Node (type stripping).

// stopFrame is inclusive, the same as "stop_frame" on the server
export interface FrameRange {
    startFrame: number;
    stopFrame: number;
    frameStep: number;
}

export interface SamplingPreset {
    key: string;
    label: string;
    step: number;
    outputFps: number;
}

export interface SamplingWarning {
    key: string;
    message: string;
}

export interface SamplingVideoInfo {
    fps: number;
    frameCount: number;
    vfr: boolean;
    bitDepth: number;
    editListOffsetFrames: number;
}

// values of the "startFrame", "stopFrame" and "frameStep" fields of the advanced configuration form
export interface FrameRangeFormValues {
    startFrame?: number | string;
    stopFrame?: number | string;
    frameStep?: number | string;
}

export const PRESET_TARGET_FPS = [15, 10, 5, 1];
export const MIN_TRACKING_FPS = 5;
export const MANY_FRAMES_THRESHOLD = 3000;

export function formatFps(fps: number): string {
    return `${+fps.toFixed(2)}`;
}

export function stepForTargetFps(fps: number, targetFps: number): number {
    return Math.max(1, Math.round(fps / targetFps));
}

export function samplingPresets(fps: number): SamplingPreset[] {
    const presets: SamplingPreset[] = [{
        key: 'all', label: `All (${formatFps(fps)} fps)`, step: 1, outputFps: fps,
    }];

    for (const target of PRESET_TARGET_FPS) {
        const step = stepForTargetFps(fps, target);
        if (!presets.some((preset) => preset.step === step)) {
            presets.push({
                key: `${target}fps`, label: `${target} fps`, step, outputFps: fps / step,
            });
        }
    }

    return presets;
}

export function countOutputFrames(range: FrameRange): number {
    if (range.stopFrame < range.startFrame) {
        return 0;
    }

    return Math.floor((range.stopFrame - range.startFrame) / range.frameStep) + 1;
}

// time when the frame starts to be shown
export function frameToSeconds(frame: number, fps: number): number {
    return frame / fps;
}

// time in the middle of the frame, seeking there shows exactly this frame
export function frameSeekTime(frame: number, fps: number): number {
    return (frame + 0.5) / fps;
}

export function secondsToFrame(seconds: number, fps: number, frameCount: number): number {
    const frame = Math.floor(seconds * fps + 1e-6);
    return Math.min(Math.max(frame, 0), Math.max(frameCount - 1, 0));
}

export function formatTime(seconds: number): string {
    const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
    const centiseconds = totalCentiseconds % 100;
    const totalSeconds = Math.floor(totalCentiseconds / 100);
    const secs = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);

    const pad = (value: number): string => `${value}`.padStart(2, '0');
    const tail = `${pad(secs)}.${pad(centiseconds)}`;
    return hours ? `${hours}:${pad(minutes)}:${tail}` : `${minutes}:${tail}`;
}

export function normalizeRange(range: FrameRange, frameCount: number): FrameRange {
    const last = Math.max(frameCount - 1, 0);
    const clamp = (value: number): number => Math.min(Math.max(Math.round(value), 0), last);

    let startFrame = clamp(range.startFrame);
    let stopFrame = clamp(range.stopFrame);
    if (startFrame > stopFrame) {
        [startFrame, stopFrame] = [stopFrame, startFrame];
    }

    const frameStep = Number.isFinite(range.frameStep) ? Math.max(1, Math.round(range.frameStep)) : 1;
    return { startFrame, stopFrame, frameStep };
}

export function fullRange(frameCount: number): FrameRange {
    return { startFrame: 0, stopFrame: Math.max(frameCount - 1, 0), frameStep: 1 };
}

export function isFullRange(range: FrameRange, frameCount: number): boolean {
    return range.startFrame === 0 && range.stopFrame >= frameCount - 1 && range.frameStep === 1;
}

function parseFormNumber(value: number | string | undefined): number | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = +value;
    return Number.isFinite(parsed) ? parsed : null;
}

// empty fields mean the defaults: from the first frame, to the last frame, every frame
export function formValuesToRange(values: FrameRangeFormValues, frameCount: number): FrameRange {
    const full = fullRange(frameCount);
    return normalizeRange({
        startFrame: parseFormNumber(values.startFrame) ?? full.startFrame,
        stopFrame: parseFormNumber(values.stopFrame) ?? full.stopFrame,
        frameStep: parseFormNumber(values.frameStep) ?? full.frameStep,
    }, frameCount);
}

// default values are left empty, so the request to the server is the same as without the block
export function rangeToFormValues(range: FrameRange, frameCount: number): FrameRangeFormValues {
    return {
        startFrame: range.startFrame === 0 ? undefined : range.startFrame,
        stopFrame: range.stopFrame >= frameCount - 1 ? undefined : range.stopFrame,
        frameStep: range.frameStep === 1 ? undefined : range.frameStep,
    };
}

export function sameRange(a: FrameRange, b: FrameRange): boolean {
    return a.startFrame === b.startFrame && a.stopFrame === b.stopFrame && a.frameStep === b.frameStep;
}

// frames to take thumbnails from, evenly spread over the whole video
export function thumbnailFrames(frameCount: number, count: number): number[] {
    const result: number[] = [];
    const total = Math.min(Math.max(count, 0), frameCount);
    for (let i = 0; i < total; i++) {
        result.push(Math.floor(((i + 0.5) * frameCount) / total));
    }

    return result;
}

export function samplingWarnings(info: SamplingVideoInfo, range: FrameRange): SamplingWarning[] {
    const warnings: SamplingWarning[] = [];
    const outputFps = info.fps / range.frameStep;
    const outputFrames = countOutputFrames(range);

    if (range.frameStep > 1 && outputFps < MIN_TRACKING_FPS) {
        warnings.push({
            key: 'sparse',
            message: `${formatFps(outputFps)} fps is fine for detection, ` +
                'but too sparse to track objects with interpolation',
        });
    }

    if (outputFrames > MANY_FRAMES_THRESHOLD) {
        warnings.push({
            key: 'many_frames',
            message: `${outputFrames} frames in one job. Consider setting "Segment size" ` +
                'in the advanced configuration to split the task into several jobs',
        });
    }

    if (info.vfr) {
        warnings.push({
            key: 'vfr',
            message: 'The video has a variable frame rate: times are approximate, frame numbers are exact',
        });
    }

    if (info.editListOffsetFrames > 0) {
        warnings.push({
            key: 'edit_list',
            message: `The video has an edit list: frame numbers may be off by ${info.editListOffsetFrames}`,
        });
    }

    if (info.bitDepth > 8) {
        warnings.push({
            key: 'bit_depth',
            message: `The video is ${info.bitDepth}-bit, which is slow to decode on the server and ` +
                'is not supported by some browsers. Converting it to 8-bit is recommended: ' +
                'ffmpeg -i in.mp4 -vf format=yuv420p -c:v libx264 -crf 20 out.mp4',
        });
    }

    return warnings;
}
