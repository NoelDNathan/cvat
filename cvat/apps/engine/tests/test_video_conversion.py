# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import os
import tempfile
import unittest
from pathlib import Path

import av
import numpy as np
from django.test import override_settings
from rest_framework.serializers import ValidationError

from cvat.apps.engine import models
from cvat.apps.engine.media_extractors import VideoReader
from cvat.apps.engine.video_conversion import convert_task_video, convert_video_to_8bit_h264

ASSETS_DIR = Path(__file__).parent / "assets"


def generate_high_bit_depth_video(path: Path, *, width: int, height: int, frames: int) -> None:
    # ffv1 is a lossless codec which is always available in PyAV and supports 10-bit formats
    with av.open(str(path), "w", format="matroska") as container:
        stream = container.add_stream("ffv1", rate=25)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p10le"

        for i in range(frames):
            image = np.full((height, width, 3), (i * 20) % 256, dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)

        for packet in stream.encode():
            container.mux(packet)


def read_video_stream_info(path: Path) -> tuple[str, str, int, int, int]:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        frame_count = sum(1 for _ in container.decode(stream))
        return (
            stream.codec_context.name,
            stream.codec_context.pix_fmt,
            stream.width,
            stream.height,
            frame_count,
        )


class _FakeData:
    def __init__(self, upload_dir: Path):
        self._upload_dir = upload_dir
        self.storage = models.StorageChoice.SHARE

    def get_upload_dirname(self) -> Path:
        return self._upload_dir


class TestConvertVideoTo8bitH264(unittest.TestCase):
    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._temp_dir.name)

    def tearDown(self):
        self._temp_dir.cleanup()

    def test_converts_10bit_video_and_keeps_all_frames(self):
        source = self.temp_dir / "input.mkv"
        target = self.temp_dir / "output.mp4"
        generate_high_bit_depth_video(source, width=64, height=48, frames=12)

        progress = []
        frame_count = convert_video_to_8bit_h264(source, target, progress_callback=progress.append)

        self.assertEqual(frame_count, 12)
        self.assertEqual(read_video_stream_info(target)[1:], ("yuv420p", 64, 48, 12))
        self.assertIn(read_video_stream_info(target)[0], {"h264", "libopenh264"})
        self.assertTrue(progress)
        self.assertEqual(progress, sorted(progress))

    def test_odd_sizes_are_padded_to_even(self):
        source = self.temp_dir / "input.mkv"
        target = self.temp_dir / "output.mp4"
        generate_high_bit_depth_video(source, width=63, height=47, frames=5)

        convert_video_to_8bit_h264(source, target)

        self.assertEqual(read_video_stream_info(target)[1:], ("yuv420p", 64, 48, 5))

    def test_rotation_is_applied_as_in_video_reader(self):
        source = ASSETS_DIR / "test_rotated_90_video.mp4"
        target = self.temp_dir / "output.mp4"

        convert_video_to_8bit_h264(source, target)

        original_frames = list(VideoReader([source]).iterate_frames(frame_filter=False))
        converted_frames = list(VideoReader([target]).iterate_frames(frame_filter=False))
        self.assertEqual(len(converted_frames), len(original_frames))
        self.assertEqual(
            (converted_frames[0][0].width, converted_frames[0][0].height),
            (original_frames[0][0].width, original_frames[0][0].height),
        )
        with av.open(str(target)) as container:
            self.assertFalse(next(container.decode(video=0)).rotation)


class TestConvertTaskVideo(unittest.TestCase):
    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._temp_dir.name)
        self.statuses = []

    def tearDown(self):
        self._temp_dir.cleanup()

    def test_converts_uploaded_video_in_place(self):
        upload_dir = self.temp_dir / "raw"
        upload_dir.mkdir()
        generate_high_bit_depth_video(upload_dir / "video.mkv", width=32, height=32, frames=4)
        db_data = _FakeData(upload_dir)
        db_data.storage = models.StorageChoice.LOCAL

        result_dir = convert_task_video(
            db_data,
            upload_dir=upload_dir,
            video="video.mkv",
            has_manifest=False,
            update_status=self.statuses.append,
        )

        self.assertEqual(result_dir, upload_dir)
        self.assertEqual(db_data.storage, models.StorageChoice.LOCAL)
        self.assertEqual(sorted(os.listdir(upload_dir)), ["video.mkv"])
        self.assertEqual(
            read_video_stream_info(upload_dir / "video.mkv")[1:], ("yuv420p", 32, 32, 4)
        )
        self.assertTrue(self.statuses)

    def test_video_from_share_is_written_to_task_dir(self):
        share_dir = self.temp_dir / "share"
        task_dir = self.temp_dir / "raw"
        (share_dir / "videos").mkdir(parents=True)
        task_dir.mkdir()
        generate_high_bit_depth_video(share_dir / "videos" / "a.mkv", width=32, height=32, frames=3)
        db_data = _FakeData(task_dir)

        with override_settings(SHARE_ROOT=share_dir):
            result_dir = convert_task_video(
                db_data,
                upload_dir=share_dir,
                video="videos/a.mkv",
                has_manifest=False,
                update_status=self.statuses.append,
            )

        self.assertEqual(result_dir, task_dir)
        self.assertEqual(db_data.storage, models.StorageChoice.LOCAL)
        self.assertEqual(read_video_stream_info(task_dir / "videos" / "a.mkv")[1], "yuv420p")
        # the share is not modified
        self.assertEqual(read_video_stream_info(share_dir / "videos" / "a.mkv")[1], "yuv420p10le")

    def test_manifest_is_not_supported(self):
        with self.assertRaises(ValidationError):
            convert_task_video(
                _FakeData(self.temp_dir),
                upload_dir=self.temp_dir,
                video="video.mp4",
                has_manifest=True,
                update_status=self.statuses.append,
            )

    def test_broken_video_raises_validation_error_and_leaves_no_files(self):
        (self.temp_dir / "video.mp4").write_bytes(b"not a video")
        db_data = _FakeData(self.temp_dir)
        db_data.storage = models.StorageChoice.LOCAL

        with self.assertRaises(ValidationError):
            convert_task_video(
                db_data,
                upload_dir=self.temp_dir,
                video="video.mp4",
                has_manifest=False,
                update_status=self.statuses.append,
            )

        self.assertEqual(os.listdir(self.temp_dir), ["video.mp4"])
