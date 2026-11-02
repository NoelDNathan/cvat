// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { Mp4VideoInfo, readFileMp4Info } from 'utils/mp4-info';

export interface VideoInfoState {
    status: 'loading' | 'ready' | 'unsupported';
    info: Mp4VideoInfo | null;
    // object URL of the local file, revoked when the file changes
    url: string | null;
    canPreview: boolean;
}

const LOADING: VideoInfoState = {
    status: 'loading', info: null, url: null, canPreview: false,
};

function browserCanPlay(info: Mp4VideoInfo): boolean {
    if (!info.codecString) {
        // unknown codec parameters, the player falls back on a playback error
        return true;
    }

    return document.createElement('video').canPlayType(`video/mp4; codecs="${info.codecString}"`) !== '';
}

export default function useVideoInfo(file: File): VideoInfoState {
    const [state, setState] = useState<VideoInfoState>(LOADING);

    useEffect(() => {
        let cancelled = false;
        const url = URL.createObjectURL(file);
        setState(LOADING);

        readFileMp4Info(file).then((info) => {
            if (!cancelled) {
                setState({
                    status: info ? 'ready' : 'unsupported',
                    info,
                    url,
                    canPreview: !!info && browserCanPlay(info),
                });
            }
        });

        return () => {
            cancelled = true;
            URL.revokeObjectURL(url);
        };
    }, [file]);

    return state;
}
