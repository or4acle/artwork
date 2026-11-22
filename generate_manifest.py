#!/usr/bin/env python3
"""Gera media.json com os arquivos encontrados dentro de media/."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
MEDIA = ROOT / "media"
EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg",
    ".mp4", ".webm", ".ogv", ".mov", ".m4v",
    ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac",
}

paths = sorted(
    path.relative_to(ROOT).as_posix()
    for path in MEDIA.rglob("*")
    if path.is_file() and path.suffix.lower() in EXTENSIONS
)
(ROOT / "media.json").write_text(
    json.dumps(paths, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(f"{len(paths)} arquivo(s) adicionado(s) ao media.json")
