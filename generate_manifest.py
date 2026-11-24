#!/usr/bin/env python3
"""Scan media/ and build media.json (plus thumbnails in thumbs/).

Usage:
    python generate_manifest.py              # manifest + thumbnails
    python generate_manifest.py --no-thumbs  # manifest only; keeps existing thumbnails

Optional helpers:
    Pillow (python -m pip install Pillow) -> image dimensions + image thumbnails
    ffmpeg / ffprobe                     -> media duration + video thumbnails

The script is deliberately fault-tolerant: one damaged or unsupported file should
not prevent the rest of the gallery from being indexed and deployed.
"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MEDIA = ROOT / "media"
THUMBS = ROOT / "thumbs"
MANIFEST = ROOT / "media.json"
THUMB_MAX = 640

IMAGES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg"}
VIDEOS = {".mp4", ".webm", ".ogv", ".m4v"}
AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}
SUPPORTED = IMAGES | VIDEOS | AUDIO

try:
    from PIL import Image, ImageOps
except ImportError:  # Pillow is optional for local runs.
    Image = None
    ImageOps = None

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
MAKE_THUMBS = "--no-thumbs" not in sys.argv


def kind_of(suffix: str) -> str:
    if suffix in IMAGES:
        return "image"
    if suffix in VIDEOS:
        return "video"
    return "audio"


def probe(path: Path) -> tuple[int, int, int]:
    """Return (width, height, duration), or zeroes if probing fails."""
    if not HAS_FFMPEG:
        return 0, 0, 0

    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-show_format", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        data = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError) as error:
        print(f"  ! could not probe {path.name}: {error}")
        return 0, 0, 0

    width = height = 0
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and stream.get("width"):
            width = int(stream.get("width", 0))
            height = int(stream.get("height", 0))
            rotation = stream.get("tags", {}).get("rotate")
            for side in stream.get("side_data_list", []):
                rotation = side.get("rotation", rotation)
            try:
                if rotation is not None and abs(int(float(rotation))) % 180 == 90:
                    width, height = height, width
            except (TypeError, ValueError):
                pass
            break

    try:
        duration = round(float(data.get("format", {}).get("duration", 0)))
    except (TypeError, ValueError):
        duration = 0
    return width, height, duration


def thumb_name(rel: str, stat, extension: str) -> str:
    key = f"{rel}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
    return hashlib.sha1(key).hexdigest()[:16] + extension


def image_entry(path: Path, rel: str, stat) -> tuple[int, int, str | None]:
    """Return dimensions and an optional thumbnail path for an image."""
    # SVG is rendered natively by the browser; Pillow is not needed for it.
    if path.suffix.lower() == ".svg" or Image is None:
        return 0, 0, None

    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source) if ImageOps else source.copy()
            width, height = image.size

            small_enough = max(width, height) <= THUMB_MAX and stat.st_size < 200_000
            if small_enough or not MAKE_THUMBS:
                return width, height, None

            output = THUMBS / thumb_name(rel, stat, ".webp")
            if not output.exists():
                thumb = image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB")
                thumb.thumbnail((THUMB_MAX, THUMB_MAX))
                # Save to a temporary file first so an interrupted write cannot
                # leave a corrupt thumbnail that looks complete on the next run.
                with tempfile.NamedTemporaryFile(
                    suffix=".webp", dir=THUMBS, delete=False
                ) as temporary:
                    temp_path = Path(temporary.name)
                try:
                    thumb.save(temp_path, "WEBP", quality=78, method=4)
                    temp_path.replace(output)
                finally:
                    temp_path.unlink(missing_ok=True)
            return width, height, f"thumbs/{output.name}"

    except Exception as error:
        # AVIF decoding depends on the Pillow build. If unsupported, the original
        # AVIF is still listed and browsers can display it directly.
        print(f"  ! could not process image {rel}: {error}")
        return 0, 0, None


def video_thumb(path: Path, rel: str, stat, duration: int) -> str | None:
    if not (HAS_FFMPEG and MAKE_THUMBS):
        return None

    output = THUMBS / thumb_name(rel, stat, ".jpg")
    if output.exists():
        return f"thumbs/{output.name}"

    seek = "1" if duration >= 3 else "0"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-ss", seek,
                "-i", str(path), "-frames:v", "1",
                "-vf", f"scale={THUMB_MAX}:{THUMB_MAX}:force_original_aspect_ratio=decrease",
                "-q:v", "4", str(output),
            ],
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        output.unlink(missing_ok=True)
        print(f"  ! video thumbnail failed for {rel}: {error}")
        return None

    if result.returncode != 0 or not output.exists() or output.stat().st_size == 0:
        output.unlink(missing_ok=True)
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        print(f"  ! no thumbnail for {rel}" + (f": {detail[-300:]}" if detail else ""))
        return None

    return f"thumbs/{output.name}"


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    THUMBS.mkdir(parents=True, exist_ok=True)

    entries = []
    used_thumbnails = set()
    paths = sorted(
        path for path in MEDIA.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SUPPORTED
        and not any(part.startswith(".") for part in path.relative_to(MEDIA).parts)
    )

    for path in paths:
        try:
            relative_path = path.relative_to(ROOT).as_posix()
            parts = path.relative_to(MEDIA).parts
            stat = path.stat()
            kind = kind_of(path.suffix.lower())

            entry = {
                "path": relative_path,
                "name": path.name,
                "album": parts[0] if len(parts) > 1 else "Unsorted",
                "kind": kind,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            }

            thumbnail = None
            if kind == "image":
                width, height, thumbnail = image_entry(path, relative_path, stat)
            else:
                width, height, duration = probe(path)
                if duration:
                    entry["dur"] = duration
                if kind == "video":
                    thumbnail = video_thumb(path, relative_path, stat, duration)

            if width and height:
                entry["w"], entry["h"] = width, height
            if thumbnail:
                entry["thumb"] = thumbnail
                used_thumbnails.add(Path(thumbnail).name)
            entries.append(entry)

        except Exception as error:
            # Keep indexing the remaining files if one path behaves unexpectedly.
            print(f"  ! skipped {path}: {error}")

    # --no-thumbs is intended to update only the manifest, not erase thumbnails.
    if MAKE_THUMBS:
        for stale in THUMBS.iterdir():
            if stale.is_file() and stale.name not in used_thumbnails:
                try:
                    stale.unlink()
                except OSError as error:
                    print(f"  ! could not remove stale thumbnail {stale.name}: {error}")

    serialized = json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n"
    temporary_manifest = ROOT / "media.json.tmp"
    temporary_manifest.write_text(serialized, encoding="utf-8")
    temporary_manifest.replace(MANIFEST)

    notes = []
    if Image is None:
        notes.append("Pillow missing: image dimensions and thumbnails are unavailable")
    if not HAS_FFMPEG:
        notes.append("FFmpeg missing: video thumbnails and media durations are unavailable")

    print(
        f"Found {len(entries)} media file(s), "
        f"{len(used_thumbnails)} thumbnail(s). Updated media.json."
    )
    for note in notes:
        print(f"  note: {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
