// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import Slider from 'antd/lib/slider';

import { formatTime, frameToSeconds } from 'utils/video-sampling';

interface Props {
    frameCount: number;
    fps: number;
    startFrame: number;
    stopFrame: number;
    currentFrame: number | null;
    thumbnails: (string | null)[];
    onSeek(frame: number): void;
    onRangeChange(startFrame: number, stopFrame: number): void;
    onRangeChangeComplete(startFrame: number, stopFrame: number): void;
}

function RangeFilmstrip(props: Props): JSX.Element {
    const {
        frameCount, fps, startFrame, stopFrame, currentFrame, thumbnails,
        onSeek, onRangeChange, onRangeChangeComplete,
    } = props;

    const toPercent = (frame: number): string => `${(frame / frameCount) * 100}%`;

    const handleStripClick = (event: React.MouseEvent<HTMLDivElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        const frame = Math.floor(((event.clientX - rect.left) / rect.width) * frameCount);
        onSeek(Math.min(Math.max(frame, 0), frameCount - 1));
    };

    return (
        <div className='cvat-video-sampling-filmstrip'>
            <div
                className='cvat-video-sampling-thumbnails'
                onClick={handleStripClick}
                role='presentation'
            >
                {thumbnails.map((thumbnail, index) => (
                    thumbnail ? (
                        <img key={index} src={thumbnail} alt='' draggable={false} />
                    ) : (
                        <div key={index} className='cvat-video-sampling-thumbnail-placeholder' />
                    )
                ))}
                <div
                    className='cvat-video-sampling-excluded'
                    style={{ left: 0, width: toPercent(startFrame) }}
                />
                <div
                    className='cvat-video-sampling-excluded'
                    style={{ left: toPercent(stopFrame + 1), right: 0 }}
                />
                {currentFrame !== null && (
                    <div className='cvat-video-sampling-playhead' style={{ left: toPercent(currentFrame) }} />
                )}
            </div>
            <Slider
                range
                className='cvat-video-sampling-range'
                min={0}
                max={frameCount - 1}
                value={[startFrame, stopFrame]}
                tooltip={{
                    formatter: (value?: number) => (
                        typeof value === 'number' ? `${value} · ${formatTime(frameToSeconds(value, fps))}` : null
                    ),
                }}
                onChange={([start, stop]: number[]) => onRangeChange(start, stop)}
                onChangeComplete={([start, stop]: number[]) => onRangeChangeComplete(start, stop)}
            />
        </div>
    );
}

export default React.memo(RangeFilmstrip);
