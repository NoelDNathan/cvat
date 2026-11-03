// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Minimal MP4/MOV box reader: gets the video track parameters without loading the whole file.
// Only the box headers and the "moov" box are read, so it works for big files with "moov" at the end.
// The file intentionally has no imports and no enums, so it can be tested with plain Node (type stripping).

/* eslint-disable no-bitwise */
// codec configuration records pack several fields into single bytes, bit operations are required to read them

export interface Mp4VideoInfo {
    width: number;
    height: number;
    timescale: number;
    durationSeconds: number;
    // frames that a decoder outputs, samples hidden by an edit list are not counted
    frameCount: number;
    fps: number;
    vfr: boolean;
    // sample entry type: 'avc1', 'hvc1', ...
    codec: string;
    codecName: string;
    // RFC 6381 codecs parameter, for HTMLMediaElement.canPlayType()
    codecString?: string;
    profileName?: string;
    bitDepth: number;
    // samples hidden by an edit list at the beginning of the video
    editListOffsetFrames: number;
}

export type Mp4RangeReader = (start: number, end: number) => Promise<Uint8Array>;

interface Box {
    type: string;
    // offsets of the payload (after the header) and of the end of the box
    start: number;
    end: number;
}

interface VideoTrack {
    width: number;
    height: number;
    timescale: number;
    sampleDeltas: [number, number][];
    compositionOffsets: [number, number][];
    editMediaTime: number;
    entry: Box | null;
}

export const MAX_MOOV_SIZE = 64 * 1024 * 1024;

const TOP_LEVEL_TYPES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'meta'];

const H264_PROFILES: Record<number, string> = {
    66: 'Baseline',
    77: 'Main',
    88: 'Extended',
    100: 'High',
    110: 'High 10',
    122: 'High 4:2:2',
    244: 'High 4:4:4',
};

const HEVC_PROFILES: Record<number, string> = {
    1: 'Main',
    2: 'Main 10',
    3: 'Main Still Picture',
    4: 'Range Extensions',
};

const CODEC_NAMES: Record<string, string> = {
    avc1: 'H.264',
    avc3: 'H.264',
    hvc1: 'HEVC',
    hev1: 'HEVC',
    av01: 'AV1',
    vp09: 'VP9',
    mp4v: 'MPEG-4 Part 2',
};

function fourCC(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function hex2(value: number): string {
    return value.toString(16).toUpperCase().padStart(2, '0');
}

// reads a box header at "offset" of "view", returns null if the box is truncated or broken
function boxAt(view: DataView, offset: number, limit: number): Box | null {
    if (offset + 8 > limit) {
        return null;
    }

    let size = view.getUint32(offset);
    const type = fourCC(new Uint8Array(view.buffer, view.byteOffset), offset + 4);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > limit) {
            return null;
        }
        size = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
    } else if (size === 0) {
        size = limit - offset;
    }

    if (size < headerSize || offset + size > limit) {
        return null;
    }

    return { type, start: offset + headerSize, end: offset + size };
}

function children(view: DataView, start: number, end: number): Box[] {
    const result: Box[] = [];
    let offset = start;
    while (offset < end) {
        const box = boxAt(view, offset, end);
        if (!box) {
            break;
        }
        result.push(box);
        offset = box.end;
    }

    return result;
}

function child(view: DataView, parent: Box, type: string): Box | null {
    return children(view, parent.start, parent.end).find((box) => box.type === type) ?? null;
}

function path(view: DataView, parent: Box, types: string[]): Box | null {
    let current: Box | null = parent;
    for (let i = 0; i < types.length && current; i++) {
        current = child(view, current, types[i]);
    }

    return current;
}

function readEntries(view: DataView, box: Box | null, signed = false): [number, number][] {
    if (!box) {
        return [];
    }

    const count = view.getUint32(box.start + 4);
    const entries: [number, number][] = [];
    for (let i = 0; i < count; i++) {
        const offset = box.start + 8 + i * 8;
        if (offset + 8 > box.end) {
            break;
        }
        entries.push([
            view.getUint32(offset),
            signed ? view.getInt32(offset + 4) : view.getUint32(offset + 4),
        ]);
    }

    return entries;
}

// media time of the first edit that is not empty, 0 if there are no edits
function readEditMediaTime(view: DataView, edts: Box | null): number {
    const elst = edts ? child(view, edts, 'elst') : null;
    if (!elst) {
        return 0;
    }

    const version = view.getUint8(elst.start);
    const count = view.getUint32(elst.start + 4);
    const entrySize = version === 1 ? 20 : 12;
    for (let i = 0; i < count; i++) {
        const offset = elst.start + 8 + i * entrySize;
        if (offset + entrySize > elst.end) {
            break;
        }
        const mediaTime = version === 1 ?
            Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4);
        if (mediaTime !== -1) {
            return Math.max(mediaTime, 0);
        }
    }

    return 0;
}

function readVideoTrack(view: DataView, trak: Box): VideoTrack | null {
    const hdlr = path(view, trak, ['mdia', 'hdlr']);
    if (!hdlr || fourCC(new Uint8Array(view.buffer, view.byteOffset), hdlr.start + 8) !== 'vide') {
        return null;
    }

    const mdhd = path(view, trak, ['mdia', 'mdhd']);
    const stbl = path(view, trak, ['mdia', 'minf', 'stbl']);
    if (!mdhd || !stbl) {
        return null;
    }

    const mdhdVersion = view.getUint8(mdhd.start);
    const timescale = view.getUint32(mdhd.start + (mdhdVersion === 1 ? 20 : 12));

    let width = 0;
    let height = 0;
    const tkhd = child(view, trak, 'tkhd');
    if (tkhd) {
        const offset = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 88 : 76);
        if (offset + 8 <= tkhd.end) {
            width = Math.round(view.getUint32(offset) / 65536);
            height = Math.round(view.getUint32(offset + 4) / 65536);
        }
    }

    let entry: Box | null = null;
    const stsd = child(view, stbl, 'stsd');
    if (stsd) {
        [entry = null] = children(view, stsd.start + 8, stsd.end);
    }

    // visual sample entry: 6 reserved, 2 data reference index, 16 pre defined, then width and height
    if (entry && (!width || !height) && entry.start + 28 <= entry.end) {
        width = view.getUint16(entry.start + 24);
        height = view.getUint16(entry.start + 26);
    }

    return {
        width,
        height,
        timescale,
        sampleDeltas: readEntries(view, child(view, stbl, 'stts')),
        compositionOffsets: readEntries(view, child(view, stbl, 'ctts'), true),
        editMediaTime: readEditMediaTime(view, child(view, trak, 'edts')),
        entry,
    };
}

// samples whose composition time is before the media time of the edit list are not shown
function countHiddenSamples(track: VideoTrack): number {
    if (!track.editMediaTime) {
        return 0;
    }

    const offsets: number[] = [];
    for (const [count, offset] of track.compositionOffsets) {
        for (let i = 0; i < count; i++) offsets.push(offset);
    }

    let hidden = 0;
    let decodeTime = 0;
    let index = 0;
    for (const [count, delta] of track.sampleDeltas) {
        for (let i = 0; i < count; i++, index++) {
            if (decodeTime + (offsets[index] ?? 0) < track.editMediaTime) {
                hidden++;
            }
            decodeTime += delta;
        }
    }

    return hidden;
}

interface CodecDetails {
    codecString?: string;
    profileName?: string;
    bitDepth?: number;
}

function readAvcConfig(bytes: Uint8Array, box: Box, type: string): CodecDetails {
    const profile = bytes[box.start + 1];
    const compatibility = bytes[box.start + 2];
    const level = bytes[box.start + 3];
    const result: CodecDetails = {
        codecString: `${type}.${hex2(profile)}${hex2(compatibility)}${hex2(level)}`,
        profileName: H264_PROFILES[profile] ?? `profile ${profile}`,
    };

    if (profile === 66 && compatibility & 0x40) {
        result.profileName = 'Constrained Baseline';
    }

    // the bit depth is written after the parameter sets for the high profiles
    let offset = box.start + 5;
    const spsCount = bytes[offset] & 0x1f;
    offset += 1;
    for (let i = 0; i < spsCount && offset + 2 <= box.end; i++) {
        offset += 2 + ((bytes[offset] << 8) | bytes[offset + 1]);
    }
    const ppsCount = bytes[offset];
    offset += 1;
    for (let i = 0; i < ppsCount && offset + 2 <= box.end; i++) {
        offset += 2 + ((bytes[offset] << 8) | bytes[offset + 1]);
    }
    if ([100, 110, 122, 144, 244].includes(profile) && offset + 4 <= box.end) {
        result.bitDepth = (bytes[offset + 1] & 0x07) + 8;
    } else if (profile === 110) {
        result.bitDepth = 10;
    }

    return result;
}

function readHevcConfig(bytes: Uint8Array, box: Box, type: string): CodecDetails {
    if (box.start + 18 > box.end) {
        return {};
    }

    const flags = bytes[box.start + 1];
    const space = flags >> 6;
    const tier = (flags >> 5) & 1;
    const profile = flags & 0x1f;

    // compatibility flags are written in the reverse bit order
    let compatibility = 0;
    const compatibilityBits = ((bytes[box.start + 2] << 24) | (bytes[box.start + 3] << 16) |
        (bytes[box.start + 4] << 8) | bytes[box.start + 5]) >>> 0;
    for (let i = 0; i < 32; i++) {
        if (compatibilityBits & (1 << i)) {
            compatibility |= 1 << (31 - i);
        }
    }

    const constraints = Array.from(bytes.subarray(box.start + 6, box.start + 12));
    while (constraints.length && constraints[constraints.length - 1] === 0) {
        constraints.pop();
    }

    const level = bytes[box.start + 12];
    const parts = [
        type,
        `${['', 'A', 'B', 'C'][space]}${profile}`,
        (compatibility >>> 0).toString(16).toUpperCase(),
        `${tier ? 'H' : 'L'}${level}`,
        ...constraints.map((value) => value.toString(16).toUpperCase()),
    ];

    return {
        codecString: parts.join('.'),
        profileName: HEVC_PROFILES[profile] ?? `profile ${profile}`,
        bitDepth: (bytes[box.start + 17] & 0x07) + 8,
    };
}

function readCodecDetails(view: DataView, entry: Box | null): CodecDetails {
    if (!entry) {
        return {};
    }

    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const type = fourCC(bytes, entry.start - 4);
    // the visual sample entry has 78 bytes before its child boxes
    const configs = children(view, entry.start + 78, entry.end);
    const avcC = configs.find((box) => box.type === 'avcC');
    if (avcC && avcC.start + 6 <= avcC.end) {
        return readAvcConfig(bytes, avcC, type);
    }

    const hvcC = configs.find((box) => box.type === 'hvcC');
    if (hvcC) {
        return readHevcConfig(bytes, hvcC, type);
    }

    return {};
}

function frameRate(track: VideoTrack, sampleCount: number, durationSeconds: number): { fps: number, vfr: boolean } {
    // the last sample duration is often written differently, it is ignored when looking for a variable rate
    const entries = track.sampleDeltas.filter(([count, delta], index, all) => (
        delta > 0 && !(index === all.length - 1 && count === 1 && all.length > 1)
    ));

    if (!entries.length) {
        return { fps: durationSeconds ? sampleCount / durationSeconds : 0, vfr: false };
    }

    const deltas = entries.map(([, delta]) => delta);
    const vfr = Math.max(...deltas) / Math.min(...deltas) > 1.01;
    if (vfr) {
        return { fps: sampleCount / durationSeconds, vfr };
    }

    const [, dominantDelta] = entries.reduce((best, current) => (current[0] > best[0] ? current : best));
    return { fps: track.timescale / dominantDelta, vfr };
}

function describeTrack(view: DataView, track: VideoTrack): Mp4VideoInfo | null {
    const sampleCount = track.sampleDeltas.reduce((acc, [count]) => acc + count, 0);
    const mediaDuration = track.sampleDeltas.reduce((acc, [count, delta]) => acc + count * delta, 0);
    if (!sampleCount || !track.timescale) {
        return null;
    }

    const hidden = countHiddenSamples(track);
    // the edit list media time shifts the composition (e.g. because of B-frames), it doesn't shorten the video
    const durationSeconds = ((mediaDuration / track.timescale) * (sampleCount - hidden)) / sampleCount;
    const { fps, vfr } = frameRate(track, sampleCount, mediaDuration / track.timescale);
    const codec = track.entry ?
        fourCC(new Uint8Array(view.buffer, view.byteOffset), track.entry.start - 4) : 'unknown';
    const details = readCodecDetails(view, track.entry);

    return {
        width: track.width,
        height: track.height,
        timescale: track.timescale,
        durationSeconds,
        frameCount: sampleCount - hidden,
        fps,
        vfr,
        codec,
        codecName: CODEC_NAMES[codec] ?? codec,
        codecString: details.codecString,
        profileName: details.profileName,
        bitDepth: details.bitDepth ?? 8,
        editListOffsetFrames: hidden,
    };
}

async function findMoov(size: number, read: Mp4RangeReader): Promise<{ start: number, end: number } | null> {
    let offset = 0;
    let first = true;
    while (offset + 8 <= size) {
        const header = await read(offset, Math.min(offset + 16, size));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const box = boxAt(view, 0, Number.MAX_SAFE_INTEGER);
        if (!box || (first && !TOP_LEVEL_TYPES.includes(box.type))) {
            return null;
        }

        if (box.type === 'moov') {
            const end = offset + box.end;
            return end <= size ? { start: offset, end } : null;
        }

        first = false;
        offset += box.end;
    }

    return null;
}

// returns null if the file is not MP4/MOV, has no video track or is broken
export async function readMp4Info(size: number, read: Mp4RangeReader): Promise<Mp4VideoInfo | null> {
    try {
        const location = await findMoov(size, read);
        if (!location || location.end - location.start > MAX_MOOV_SIZE) {
            return null;
        }

        const bytes = await read(location.start, location.end);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const moov = boxAt(view, 0, bytes.byteLength);
        if (!moov) {
            return null;
        }

        const traks = children(view, moov.start, moov.end).filter((box) => box.type === 'trak');
        for (const trak of traks) {
            const track = readVideoTrack(view, trak);
            if (track) {
                return describeTrack(view, track);
            }
        }
    } catch {
        // truncated or unusual files are reported as unsupported
    }

    return null;
}

export function readFileMp4Info(file: Blob): Promise<Mp4VideoInfo | null> {
    return readMp4Info(file.size, (start, end) => (
        file.slice(start, end).arrayBuffer().then((buffer) => new Uint8Array(buffer))
    ));
}
