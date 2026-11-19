"""drive-pane backend: read-only directory listing of the Google Drive mirror.

Mounted at /api/plugins/drive-pane/ inside the gateway. Only lists folders
under ROOT; never reads file contents, never writes.
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
async def root_info():
    return {"root": str(ROOT), "exists": ROOT.is_dir()}


@router.get("/list")
async def list_dir(path: str = "", hidden: bool = False):
    target = _resolve(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a folder")
    entries = []
    truncated = False
    try:
        with os.scandir(target) as it:
            for e in it:
                if not hidden and e.name.startswith("."):
                    continue
                if len(entries) >= MAX_ENTRIES:
                    truncated = True
                    break
                try:
                    is_dir = e.is_dir()
                    size = None if is_dir else e.stat().st_size
                except OSError:
                    is_dir, size = False, None
                entries.append({"name": e.name, "dir": is_dir, "size": size})
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")
    entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    rel = "" if target == ROOT.resolve() else str(target.relative_to(ROOT.resolve()))
    return {
        "root": str(ROOT),
        "path": rel,
        "abs": str(target),
        "entries": entries,
        "truncated": truncated,
    }
