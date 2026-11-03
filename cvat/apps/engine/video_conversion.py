# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

"""
Optional conversion of an uploaded video to 8-bit H.264 before the task data is processed.

Videos with a higher bit depth (e.g. H.264 High 10 from phones and action cameras) are slow
to decode, and the server decodes the source video every time a chunk is prepared.
The conversion keeps every frame, so frame numbers stay the same, and applies the rotation
from the video metadata in the same way as VideoReader does.
"""

import os
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path

import av
import av.codec.codec
from django.conf import settings
from rest_framework.serializers import ValidationError

from cvat.apps.engine import models
from cvat.apps.engine.log import ServerLogManager
from cvat.apps.engine.media_extractors import Mpeg4ChunkWriter
from cvat.apps.engine.utils import rotate_image

slogger = ServerLogManager(__name__)

OUTPUT_PIXEL_FORMAT = "yuv420p"
# fixed quantizer for libopenh264 (0 is the best quality, 51 is the worst)
OPENH264_QUANTIZER = 20
LIBX264_CRF = 20
DEFAULT_FRAME_RATE = Fraction(25)
PROGRESS_STEP = 0.05


def _get_encoder() -> tuple[str, dict[str, str]]:
    # the same preference as in Mpeg4ChunkWriter: libopenh264 is shipped with PyAV, libx264 is not
    try:
        return av.codec.Codec("libopenh264", "w").name, {}
    except av.codec.codec.UnknownCodecError:
        return av.codec.Codec("libx264", "w").name, {
            "crf": str(LIBX264_CRF),
            "preset": "veryfast",
        }


def _rotated(frame: av.VideoFrame) -> av.VideoFrame:
    if not frame.rotation:
        return frame

    return av.VideoFrame.from_ndarray(
        rotate_image(frame.to_ndarray(format="bgr24"), frame.rotation), format="bgr24"
    )


def convert_video_to_8bit_h264(
    source: Path,
    destination: Path,
    *,
    progress_callback: Callable[[float], None] | None = None,
) -> int:
    """
    Converts the first video stream of the source file to 8-bit H.264 in an MP4 container.
    Audio and other streams are dropped. Returns the number of converted frames.
    """

    encoder_name, encoder_options = _get_encoder()

    with av.open(str(source), "r") as input_container:
        input_stream = input_container.streams.video[0]
        input_stream.thread_type = "AUTO"
        frame_rate = input_stream.average_rate or input_stream.guessed_rate or DEFAULT_FRAME_RATE
        # only used for the progress, some containers (e.g. Matroska) only know the total duration
        if input_stream.frames:
            expected_frames = input_stream.frames
        elif input_stream.duration:
            expected_frames = int(input_stream.duration * input_stream.time_base * frame_rate)
        elif input_container.duration:
            expected_frames = int(Fraction(input_container.duration, av.time_base) * frame_rate)
        else:
            expected_frames = 0

        with av.open(str(destination), "w", format="mp4") as output_container:
            output_stream: av.video.stream.VideoStream | None = None
            frame_count = 0
            reported_progress = 0.0

            for frame in input_container.decode(input_stream):
                frame = _rotated(frame)

                if output_stream is None:
                    width, height = frame.width, frame.height
                    if encoder_name == "libopenh264" and width * height > (
                        Mpeg4ChunkWriter.MAX_MBS_PER_FRAME << 8
                    ):
                        raise ValidationError(
                            f"The video resolution {width}x{height} is too high "
                            "for the conversion to 8-bit H.264"
                        )

                    output_stream = output_container.add_stream(encoder_name, rate=frame_rate)
                    # yuv420p requires even sizes, as in Mpeg4ChunkWriter
                    output_stream.width = width + width % 2
                    output_stream.height = height + height % 2
                    output_stream.pix_fmt = OUTPUT_PIXEL_FORMAT
                    if encoder_name == "libopenh264":
                        output_stream.codec_context.qmin = OPENH264_QUANTIZER
                        output_stream.codec_context.qmax = OPENH264_QUANTIZER
                    output_stream.options = encoder_options

                # every decoded frame is written once, timestamps are recreated with a constant rate
                frame.pts = None
                frame.time_base = Fraction(0, 1)
                for packet in output_stream.encode(frame):
                    output_container.mux(packet)

                frame_count += 1
                if progress_callback and expected_frames:
                    progress = min(frame_count / expected_frames, 1.0)
                    if progress - reported_progress >= PROGRESS_STEP:
                        reported_progress = progress
                        progress_callback(progress)

            if output_stream is None:
                raise ValidationError("The video has no frames to convert")

            for packet in output_stream.encode():
                output_container.mux(packet)

    return frame_count


def convert_task_video(
    db_data: models.Data,
    *,
    upload_dir: Path,
    video: str,
    has_manifest: bool,
    update_status: Callable[[str], None],
) -> Path:
    """
    Converts the task video in place, before the media is extracted.
    Returns the directory where the task media is located after the conversion:
    videos from a file share are written to the task data directory,
    because the share can not be modified.
    """

    if has_manifest:
        raise ValidationError(
            "A video can not be converted to 8-bit H.264 when a manifest file is provided, "
            "because the manifest describes the original video"
        )

    source = Path(upload_dir) / video
    target_dir = Path(upload_dir)
    if Path(upload_dir) == Path(settings.SHARE_ROOT):
        target_dir = Path(db_data.get_upload_dirname())
        db_data.storage = models.StorageChoice.LOCAL
    target = target_dir / video
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_target = target.with_name(f".{target.name}.converting.mp4")

    update_status("Converting the video to 8-bit H.264...")

    def report(progress: float) -> None:
        update_status(f"Converting the video to 8-bit H.264: {round(progress * 100)}%")

    try:
        frame_count = convert_video_to_8bit_h264(source, temporary_target, progress_callback=report)
        # the file name is kept: the uploaded file list and the media list refer to it
        os.replace(temporary_target, target)
    except av.FFmpegError as ex:
        raise ValidationError(f"Could not convert the video to 8-bit H.264: {ex}") from ex
    finally:
        temporary_target.unlink(missing_ok=True)

    slogger.glob.info(f"Converted '{video}' to 8-bit H.264, {frame_count} frames")
    return target_dir
