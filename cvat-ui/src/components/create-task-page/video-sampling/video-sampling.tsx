// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Checkbox, { CheckboxChangeEvent } from 'antd/lib/checkbox';
import InputNumber from 'antd/lib/input-number';
import Segmented from 'antd/lib/segmented';
import Spin from 'antd/lib/spin';
import Text from 'antd/lib/typography/Text';

import { Mp4VideoInfo } from 'utils/mp4-info';
import {
    FrameRange, FrameRangeFormValues, countOutputFrames, formValuesToRange, formatFps, formatTime, frameSeekTime,
    frameToSeconds, normalizeRange, rangeToFormValues, samplingPresets, samplingWarnings, secondsToFrame,
    thumbnailFrames,
} from 'utils/video-sampling';
import RangeFilmstrip from './range-filmstrip';
import useThumbnails from './use-thumbnails';
import useVideoInfo from './use-video-info';

interface Props {
    file: File;
    // values of the frame range fields of the advanced configuration form
    frameRange: FrameRangeFormValues;
    onChange(frameRange: FrameRangeFormValues): void;
    convertVideoTo8bit: boolean;
    // the server can not convert a video uploaded together with a manifest
    canConvertVideo: boolean;
    onChangeConvertVideoTo8bit(value: boolean): void;
}

const THUMBNAIL_COUNT = 16;
const CUSTOM_STEP = 'custom';

function ordinal(value: number): string {
    const tens = value % 100;
    if (tens >= 11 && tens <= 13) return `${value}th`;
    return `${value}${['th', 'st', 'nd', 'rd'][value % 10] ?? 'th'}`;
}

function describeVideo(info: Mp4VideoInfo): string {
    const codec = [info.codecName, info.profileName].filter(Boolean).join(' ');
    return [
        `${info.width}×${info.height}`,
        `${formatFps(info.fps)} fps${info.vfr ? ' (variable)' : ''}`,
        `${info.frameCount} frames`,
        formatTime(info.durationSeconds),
        `${codec} (${info.bitDepth}-bit)`,
    ].join(' · ');
}

function describeOutput(range: FrameRange, fps: number): string {
    const start = frameToSeconds(range.startFrame, fps);
    const stop = frameToSeconds(range.stopFrame + 1, fps);
    const step = range.frameStep === 1 ?
        `every frame (${formatFps(fps)} fps)` :
        `every ${ordinal(range.frameStep)} frame (≈ ${formatFps(fps / range.frameStep)} fps)`;
    return `${formatTime(start)} → ${formatTime(stop)} (${formatTime(stop - start)}) · ${step}`;
}

function VideoSampling(props: Props): JSX.Element {
    const {
        file, frameRange, onChange, convertVideoTo8bit, canConvertVideo, onChangeConvertVideoTo8bit,
    } = props;
    const {
        status, info, url, canPreview,
    } = useVideoInfo(file);

    const [previewFailed, setPreviewFailed] = useState(false);
    const [currentFrame, setCurrentFrame] = useState(0);
    const [dragRange, setDragRange] = useState<[number, number] | null>(null);
    const [customStep, setCustomStep] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const pendingSeek = useRef<number | null>(null);
    const previousFile = useRef<File | null>(null);

    const frameCount = info?.frameCount ?? 0;
    const fps = info?.fps ?? 0;
    const preview = canPreview && !previewFailed;

    useEffect(() => {
        setPreviewFailed(false);
        setCurrentFrame(0);
        setDragRange(null);
        setCustomStep(false);
        if (previousFile.current && previousFile.current !== file) {
            // a range chosen for another video makes no sense for this one
            onChange({});
        }
        previousFile.current = file;
    }, [file]);

    useEffect(() => {
        // values typed before the video was read may be out of the video
        if (info && Object.values(frameRange).some((value) => value !== undefined && value !== '')) {
            onChange(rangeToFormValues(formValuesToRange(frameRange, info.frameCount), info.frameCount));
        }

        // the conversion is suggested for videos which are slow to decode
        onChangeConvertVideoTo8bit(!!info && info.bitDepth > 8 && canConvertVideo);
    }, [info, canConvertVideo]);

    // the option belongs to this video, it must not stay enabled when the block is hidden
    useEffect(() => () => onChangeConvertVideoTo8bit(false), []);

    const range = useMemo(() => (
        info ? formValuesToRange(frameRange, info.frameCount) : null
    ), [info, frameRange]);
    const shownRange = range && dragRange ? { ...range, startFrame: dragRange[0], stopFrame: dragRange[1] } : range;

    const presets = useMemo(() => (info ? samplingPresets(info.fps) : []), [info]);
    const framesForThumbnails = useMemo(() => (
        info ? thumbnailFrames(info.frameCount, THUMBNAIL_COUNT) : []
    ), [info]);
    const thumbnails = useThumbnails(url, framesForThumbnails, fps, preview);

    const commit = useCallback((next: FrameRange): void => {
        if (info) {
            onChange(rangeToFormValues(normalizeRange(next, info.frameCount), info.frameCount));
        }
    }, [info, onChange]);

    const seek = useCallback((frame: number): void => {
        const video = videoRef.current;
        if (!video || !fps) {
            return;
        }

        // seeks are slow for big videos, only the latest requested frame is shown after the current seek
        if (video.seeking) {
            pendingSeek.current = frame;
        } else {
            video.currentTime = frameSeekTime(frame, fps);
        }
    }, [fps]);

    const updateCurrentFrame = (): void => {
        const video = videoRef.current;
        if (video && fps) {
            setCurrentFrame(secondsToFrame(video.currentTime, fps, frameCount));
        }
    };

    const handleSeeked = (): void => {
        updateCurrentFrame();
        if (pendingSeek.current !== null) {
            const frame = pendingSeek.current;
            pendingSeek.current = null;
            seek(frame);
        }
    };

    const handleRangeChange = useCallback((startFrame: number, stopFrame: number): void => {
        // show the frame under the handle that is being moved
        const previousStart = dragRange ? dragRange[0] : range?.startFrame;
        seek(startFrame !== previousStart ? startFrame : stopFrame);
        setDragRange([startFrame, stopFrame]);
    }, [dragRange, range, seek]);

    const handleRangeChangeComplete = useCallback((startFrame: number, stopFrame: number): void => {
        setDragRange(null);
        if (range) {
            commit({ ...range, startFrame, stopFrame });
        }
    }, [range, commit]);

    if (status === 'loading') {
        return (
            <div className='cvat-video-sampling'>
                <Spin size='small' />
                <Text type='secondary'> Reading the video…</Text>
            </div>
        );
    }

    if (!info || !range || !shownRange) {
        return (
            <div className='cvat-video-sampling'>
                <Text type='secondary'>
                    Video preview is available only for MP4 and MOV files.
                    The frame range can be set in the advanced configuration.
                </Text>
            </div>
        );
    }

    const warnings = samplingWarnings(info, shownRange);
    const selectedStep = customStep || !presets.some((preset) => preset.step === range.frameStep) ?
        CUSTOM_STEP : range.frameStep;

    return (
        <div className='cvat-video-sampling'>
            <Text className='cvat-text-color'>Video sampling</Text>
            <Text type='secondary' className='cvat-video-sampling-info'>{describeVideo(info)}</Text>

            {preview && (
                <div className='cvat-video-sampling-player-wrapper'>
                    <video
                        ref={videoRef}
                        className='cvat-video-sampling-player'
                        src={url ?? undefined}
                        controls
                        muted
                        preload='metadata'
                        onTimeUpdate={updateCurrentFrame}
                        onSeeked={handleSeeked}
                        onError={() => setPreviewFailed(true)}
                    />
                    <div className='cvat-video-sampling-player-side'>
                        <Text strong>{`Frame ${currentFrame}`}</Text>
                        <Text type='secondary'>{formatTime(frameToSeconds(currentFrame, fps))}</Text>
                        <Button
                            className='cvat-video-sampling-set-start'
                            onClick={() => commit({ ...range, startFrame: Math.min(currentFrame, range.stopFrame) })}
                        >
                            Set start here
                        </Button>
                        <Button
                            className='cvat-video-sampling-set-stop'
                            onClick={() => commit({ ...range, stopFrame: Math.max(currentFrame, range.startFrame) })}
                        >
                            Set end here
                        </Button>
                    </div>
                </div>
            )}

            <RangeFilmstrip
                frameCount={frameCount}
                fps={fps}
                startFrame={shownRange.startFrame}
                stopFrame={shownRange.stopFrame}
                currentFrame={preview ? currentFrame : null}
                thumbnails={preview ? thumbnails : framesForThumbnails.map(() => null)}
                onSeek={seek}
                onRangeChange={handleRangeChange}
                onRangeChangeComplete={handleRangeChangeComplete}
            />

            <div className='cvat-video-sampling-step'>
                <Text>Sampling:</Text>
                <Segmented
                    value={selectedStep}
                    options={[
                        ...presets.map((preset) => ({ label: preset.label, value: preset.step })),
                        { label: 'Custom', value: CUSTOM_STEP },
                    ]}
                    onChange={(value: string | number) => {
                        if (value === CUSTOM_STEP) {
                            setCustomStep(true);
                        } else {
                            setCustomStep(false);
                            commit({ ...range, frameStep: +value });
                        }
                    }}
                />
                {selectedStep === CUSTOM_STEP && (
                    <InputNumber
                        className='cvat-video-sampling-custom-step'
                        min={1}
                        max={frameCount}
                        precision={0}
                        addonBefore='every'
                        addonAfter='frames'
                        value={range.frameStep}
                        onChange={(value: number | null) => {
                            if (value) commit({ ...range, frameStep: value });
                        }}
                    />
                )}
            </div>

            <Text className='cvat-video-sampling-output'>
                {`Output: ${describeOutput(shownRange, fps)} · `}
                <Text strong>{`${countOutputFrames(shownRange)} frames`}</Text>
            </Text>

            {!preview && !warnings.some((warning) => warning.key === 'bit_depth') && (
                <Alert
                    type='info'
                    showIcon
                    message='This video can not be previewed in the browser, the frame range can still be set'
                />
            )}
            {warnings.map((warning) => (
                <Alert key={warning.key} type='warning' showIcon message={warning.message} />
            ))}
            {info.bitDepth > 8 && (
                <Checkbox
                    className='cvat-video-sampling-convert'
                    checked={convertVideoTo8bit}
                    disabled={!canConvertVideo}
                    onChange={(event: CheckboxChangeEvent) => onChangeConvertVideoTo8bit(event.target.checked)}
                >
                    {canConvertVideo ?
                        'Convert to 8-bit H.264 on the server before creating the task (all frames are kept)' :
                        'Converting to 8-bit H.264 is not available when a manifest file is uploaded'}
                </Checkbox>
            )}
        </div>
    );
}

export default React.memo(VideoSampling);
