"""Builds dist/yt-channel-views-v<version>.zip for sending to clients.

Usage:  python build_zip.py
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKIP_DIRS = {".git", "dist", ".claude"}
SKIP_FILES = {"build_zip.py", ".gitignore"}

version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
out = ROOT / "dist" / f"yt-channel-views-v{version}.zip"
out.parent.mkdir(exist_ok=True)

files = sorted(
    p for p in ROOT.rglob("*")
    if p.is_file() and p.name not in SKIP_FILES and not SKIP_DIRS.intersection(p.relative_to(ROOT).parts)
)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in files:
        z.write(p, f"yt-channel-views/{p.relative_to(ROOT).as_posix()}")

print(f"{out} ({out.stat().st_size // 1024} KB, {len(files)} files)")
