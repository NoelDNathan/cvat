// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { frameSeekTime } from 'utils/video-sampling';

export const THUMBNAIL_HEIGHT = 72;

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const listeners = {
            event: (): void => {
                video.removeEventListener('error', listeners.error);
                resolve();
            },
            error: (): void => {
                video.removeEventListener(event, listeners.event);
                reject(new Error('Could not decode the video'));
            },
        };
        video.addEventListener(event, listeners.event, { once: true });
        video.addEventListener('error', listeners.error, { once: true });
    });
}

function canvasToURL(canvas: HTMLCanvasElement): Promise<string | null> {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/jpeg', 0.8);
    });
}

// takes thumbnails one by one with a hidden video element and returns them as they are ready
export default function useThumbnails(
    url: string | null, frames: number[], fps: number, enabled: boolean,
): (string | null)[] {
    const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
    const framesKey = frames.join(',');

    useEffect(() => {
        setThumbnails(frames.map(() => null));
        if (!url || !enabled || !frames.length) {
            return () => {};
        }

        let cancelled = false;
        const created: string[] = [];
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.src = url;

        (async () => {
            try {
                await waitFor(video, 'loadeddata');
                const canvas = document.createElement('canvas');
                canvas.height = THUMBNAIL_HEIGHT;
                canvas.width = Math.round((THUMBNAIL_HEIGHT * video.videoWidth) / (video.videoHeight || 1));
                const context = canvas.getContext('2d');

                for (let i = 0; i < frames.length && !cancelled && context; i++) {
                    const seeked = waitFor(video, 'seeked');
                    video.currentTime = frameSeekTime(frames[i], fps);
                    await seeked;
                    if (cancelled) break;

                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const thumbnail = await canvasToURL(canvas);
                    if (cancelled) {
                        if (thumbnail) URL.revokeObjectURL(thumbnail);
                        break;
                    }

                    if (thumbnail) {
                        created.push(thumbnail);
                        setThumbnails((previous) => {
                            const next = [...previous];
                            next[i] = thumbnail;
                            return next;
                        });
                    }
                }
            } catch {
                // thumbnails are optional, the strip stays empty when the browser can not decode the video
            }
        })();

        return () => {
            cancelled = true;
            video.removeAttribute('src');
            video.load();
            created.forEach((thumbnail) => URL.revokeObjectURL(thumbnail));
        };
    }, [url, framesKey, fps, enabled]);

    return thumbnails;
}
