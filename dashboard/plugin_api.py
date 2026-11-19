"""drive-pane backend: read-only directory listing of the Google Drive mirror.

Mounted at /api/plugins/drive-pane/ inside the gateway. Only lists folders
under ROOT; never reads file contents, never writes.

Handlers are plain ``def`` on purpose: the mirror is a FUSE mount where a cold
scandir/stat can take seconds, and FastAPI runs sync handlers in its threadpool
instead of blocking the gateway's event loop.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

ROOT = Path("/mnt/google-drive")
MAX_ENTRIES = 2000

router = APIRouter()


def _resolve(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    target = (ROOT / rel).resolve()
    root = ROOT.resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="outside root")
    return target


@router.get("/root")
def root_info():
    return {"root": str(ROOT), "exists": ROOT.is_dir()}


@router.get("/list")
def list_dir(path: str = "", hidden: bool = False):
    target = _resolve(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a folder")
    dirs: list[str] = []
    files: list[os.DirEntry] = []
    try:
        with os.scandir(target) as it:
            for e in it:
                if not hidden and e.name.startswith("."):
                    continue
                try:
                    is_dir = e.is_dir()
                except OSError:
                    is_dir = False
                if is_dir:
                    dirs.append(e.name)
                else:
                    files.append(e)
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")

    # Sort and cap after collecting everything, so truncation only ever drops
    # trailing files, never folders. stat() only the files that are returned.
    dirs.sort(key=str.lower)
    files.sort(key=lambda e: e.name.lower())
    room = max(MAX_ENTRIES - len(dirs), 0)
    truncated = len(dirs) + len(files) > MAX_ENTRIES
    entries = [{"name": n, "dir": True, "size": None} for n in dirs[:MAX_ENTRIES]]
    for e in files[:room]:
        try:
            size = e.stat().st_size
        except OSError:
            size = None
        entries.append({"name": e.name, "dir": False, "size": size})

    root = ROOT.resolve()
    rel = "" if target == root else target.relative_to(root).as_posix()
    return {
        "root": str(ROOT),
        "path": rel,
        # Built from ROOT, not the resolved target, so inserted paths stay
        # under /mnt/google-drive even if the mount point is a symlink.
        "abs": f"{ROOT.as_posix()}/{rel}" if rel else ROOT.as_posix(),
        "entries": entries,
        "truncated": truncated,
    }
