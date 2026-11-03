# MP4 fixtures for `mp4-info.test.ts`

Tiny videos (64×36, a few KB each) generated with FFmpeg 9:

```bash
ffmpeg -f lavfi -i testsrc=size=64x36:rate=30000/1001 -frames:v 10 -pix_fmt yuv420p -c:v libx264 -profile:v high cfr-8bit.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=30000/1001 -frames:v 10 -pix_fmt yuv420p10le -c:v libx264 -profile:v high10 cfr-10bit.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=25 -frames:v 10 -pix_fmt yuv420p -c:v libx264 -movflags +faststart faststart.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=25 -frames:v 10 -pix_fmt yuv420p -c:v libx264 -bf 2 -f mov qt.mov
ffmpeg -f lavfi -i testsrc=size=64x36:rate=24 -frames:v 10 -pix_fmt yuv420p10le -c:v libx265 -tag:v hvc1 hevc-10bit.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=30 -frames:v 10 -vf "setpts='if(lt(N,5),N/30,5/30+(N-5)/15)/TB'" \
    -fps_mode passthrough -pix_fmt yuv420p -c:v libx264 -bf 0 -video_track_timescale 90000 vfr.mp4

# 30 frames with one keyframe, cut at 0.5 s without re-encoding: the edit list hides 13 frames
ffmpeg -f lavfi -i testsrc=size=64x36:rate=25 -frames:v 30 -pix_fmt yuv420p -c:v libx264 -g 30 -bf 2 src30.mp4
ffmpeg -ss 0.5 -i src30.mp4 -c copy edit-list.mp4
```

Expected values come from `ffprobe -count_frames -show_streams`.
