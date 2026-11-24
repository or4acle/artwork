#!/usr/bin/env python3
"""Scan media/ and build media.json (plus thumbnails in thumbs/).

Usage:
    python generate_manifest.py              # manifest + thumbnails
    python generate_manifest.py --no-thumbs  # manifest only (fast)

Optional helpers (the script works without them, just with fewer features):
    * Pillow  (pip install pillow)  -> image sizes + image thumbnails
    * ffmpeg / ffprobe              -> video/audio duration, video thumbnails
"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MEDIA = ROOT / "media"
THUMBS = ROOT / "thumbs"
THUMB_MAX = 640  # longest side of a thumbnail, in pixels

IMAGES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg"}
VIDEOS = {".mp4", ".webm", ".ogv", ".m4v"}
AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}
SUPPORTED = IMAGES | VIDEOS | AUDIO

try:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = None
    try:  # AVIF support on older Pillow versions
        import pillow_avif  # noqa: F401
    except ImportError:
        pass
except ImportError:  # pragma: no cover
    Image = None

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
MAKE_THUMBS = "--no-thumbs" not in sys.argv


def kind_of(suffix):
    if suffix in IMAGES:
        return "image"
    if suffix in VIDEOS:
        return "video"
    return "audio"


def probe(path):
    """Return (width, height, duration) from ffprobe; zeros when unknown."""
    if not HAS_FFMPEG:
        return 0, 0, 0
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", str(path)],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        data = json.loads(out)
    except Exception:
        return 0, 0, 0
    width = height = 0
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and stream.get("width"):
            width, height = int(stream["width"]), int(stream["height"])
            rotation = stream.get("tags", {}).get("rotate")
            for side in stream.get("side_data_list", []):
                rotation = side.get("rotation", rotation)
            if rotation is not None and abs(int(float(rotation))) % 180 == 90:
                width, height = height, width
            break
    try:
        duration = float(data.get("format", {}).get("duration", 0))
    except (TypeError, ValueError):
        duration = 0
    return width, height, round(duration)


def thumb_name(rel, stat, ext):
    key = f"{rel}|{stat.st_mtime_ns}|{stat.st_size}".encode()
    return hashlib.sha1(key).hexdigest()[:16] + ext


def image_entry(path, rel, stat):
    """Return (w, h, thumb_rel_or_None) for an image."""
    if path.suffix.lower() == ".svg" or Image is None:
        return 0, 0, None
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)  # browsers honour EXIF rotation
            width, height = img.size
            small = max(width, height) <= THUMB_MAX and stat.st_size < 200_000
            if small or not MAKE_THUMBS:
                return width, height, None
            out = THUMBS / thumb_name(rel, stat, ".webp")
            if not out.exists():
                thumb = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
                thumb.thumbnail((THUMB_MAX, THUMB_MAX))
                thumb.save(out, "WEBP", quality=78, method=4)
            return width, height, f"thumbs/{out.name}"
    except Exception as error:
        print(f"  ! could not read {rel}: {error}")
        return 0, 0, None


def video_thumb(path, rel, stat, duration):
    if not (HAS_FFMPEG and MAKE_THUMBS):
        return None

    out = THUMBS / thumb_name(rel, stat, ".jpg")

    if out.exists():
        return f"thumbs/{out.name}"

    seek = "1" if duration >= 3 else "0"

    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-loglevel", "error",
                "-ss", seek,
                "-i", str(path),
                "-frames:v", "1",
                "-vf",
                f"scale={THUMB_MAX}:{THUMB_MAX}:"
                "force_original_aspect_ratio=decrease",
                "-q:v", "4",
                str(out),
            ],
            capture_output=True,
            timeout=120,
        )

        if result.returncode != 0 or not out.exists():
            print(f"  ! no thumbnail for {rel}")
            out.unlink(missing_ok=True)
            return None

        return f"thumbs/{out.name}"

    except subprocess.TimeoutExpired:
        print(f"  ! thumbnail timeout for {rel}")
        out.unlink(missing_ok=True)
        return None

    except OSError as error:
        print(f"  ! ffmpeg error for {rel}: {error}")
        out.unlink(missing_ok=True)
        return None



def main():
    THUMBS.mkdir(exist_ok=True)
    if not MEDIA.exists():
        MEDIA.mkdir()

    entries, used = [], set()
    paths = sorted(
        p for p in MEDIA.rglob("*")
        if p.is_file()
        and p.suffix.lower() in SUPPORTED
        and not any(part.startswith(".") for part in p.relative_to(MEDIA).parts)
    )
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        parts = path.relative_to(MEDIA).parts
        stat = path.stat()
        kind = kind_of(path.suffix.lower())
        entry = {
            "path": rel,
            "name": path.name,
            "album": parts[0] if len(parts) > 1 else "Unsorted",
            "kind": kind,
            "size": stat.st_size,
            "mtime": int(stat.st_mtime),
        }
        thumb = None
        if kind == "image":
            width, height, thumb = image_entry(path, rel, stat)
        else:
            width, height, duration = probe(path)
            if duration:
                entry["dur"] = duration
            if kind == "video":
                thumb = video_thumb(path, rel, stat, duration)
        if width and height:
            entry["w"], entry["h"] = width, height
        if thumb:
            entry["thumb"] = thumb
            used.add(Path(thumb).name)
        entries.append(entry)

    for stale in THUMBS.iterdir():  # drop thumbnails of deleted/changed files
        if stale.is_file() and stale.name not in used:
            stale.unlink()

    (ROOT / "media.json").write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    notes = []
    if Image is None:
        notes.append("Pillow missing: no image sizes/thumbnails")
    if not HAS_FFMPEG:
        notes.append("ffmpeg missing: no video thumbnails/durations")
    print(f"Found {len(entries)} media file(s), {len(used)} thumbnail(s). Updated media.json.")
    for note in notes:
        print(f"  note: {note}")


if __name__ == "__main__":
    main()
