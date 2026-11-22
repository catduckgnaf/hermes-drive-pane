"""drive-pane backend: read-only directory listings of the gateway host's mounts.

Mounted at /api/plugins/drive-pane/ inside the gateway. Lists folders under a
configured set of named roots; never reads file contents, never writes. A
request names a root by key, never by path, so the pane can only ever see
what the configuration lists.

The roots come from the plugin's ``roots`` setting (``plugin.yaml``
``config_schema``; stored at ``plugins.entries.drive-pane.settings.roots`` in
config.yaml and edited under Settings > Plugins). It is re-read on every
request, so edits apply without a restart. Missing or invalid settings fall
back to DEFAULT_ROOTS.

Handlers are plain ``def`` on purpose: the roots are network mounts (CIFS,
sshfs) where a cold scandir/stat can take seconds, and FastAPI runs sync
handlers in its threadpool instead of blocking the gateway's event loop.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, NamedTuple

from fastapi import APIRouter, HTTPException

PLUGIN_ID = "drive-pane"
# `local` maps a root to its desktop-machine location, per OS. Keep public
# defaults generic; operators supply their own private roots in plugin settings.
DEFAULT_ROOTS = [
    {"label": "Files", "path": "/srv/files", "key": "files", "local": {}},
]
LOCAL_OSES = ("windows", "macos", "linux")
MAX_ROOTS = 8
DEFAULT_MAX_ENTRIES = 2000

logger = logging.getLogger(__name__)
router = APIRouter()


class Root(NamedTuple):
    key: str
    label: str
    path: Path
    local: dict[str, dict[str, str]]


def _parse_local(raw: Any, i: int) -> dict[str, dict[str, str]]:
    """{os: {prefix: local path}}. A string applies to the whole root on
    every OS; an OS value may itself be a string (the whole root)."""
    if raw in (None, "", {}):
        return {}
    if isinstance(raw, str):
        raw = {os_name: raw for os_name in LOCAL_OSES}
    if not isinstance(raw, dict):
        logger.warning("drive-pane: roots[%d] local is not a mapping or string; ignored", i)
        return {}
    out: dict[str, dict[str, str]] = {}
    for os_name, value in raw.items():
        os_name = str(os_name).lower()
        if os_name not in LOCAL_OSES:
            logger.warning("drive-pane: roots[%d] local has unknown OS %r (use %s); ignored",
                           i, os_name, ", ".join(LOCAL_OSES))
            continue
        if isinstance(value, str):
            value = {"": value}
        if not isinstance(value, dict):
            continue
        prefixes = {str(k).strip("/"): str(v) for k, v in value.items() if str(v).strip()}
        if prefixes:
            out[os_name] = prefixes
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "root"


def _settings() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly
        from hermes_cli.plugins_state import _plugin_settings_entry
        entry = _plugin_settings_entry(load_config_readonly() or {}, PLUGIN_ID) or {}
        settings = entry.get("settings")
        return dict(settings) if isinstance(settings, dict) else {}
    except Exception as exc:  # no config access: the defaults still work
        logger.debug("drive-pane: cannot read settings: %s", exc)
        return {}


def _parse_roots(raw: Any) -> list[Root]:
    """Validated roots from the setting; invalid entries are skipped and logged."""
    if not isinstance(raw, list) or not raw:
        raw = DEFAULT_ROOTS
    roots: list[Root] = []
    seen: set[str] = set()
    for i, item in enumerate(raw[:MAX_ROOTS]):
        if isinstance(item, str):
            item = {"path": item}
        if not isinstance(item, dict):
            logger.warning("drive-pane: roots[%d] is not a mapping; skipped", i)
            continue
        path = str(item.get("path") or "").strip()
        if not path.startswith("/"):
            logger.warning("drive-pane: roots[%d] path %r is not absolute; skipped", i, path)
            continue
        label = str(item.get("label") or Path(path).name or path).strip()
        key = _slug(str(item.get("key") or label))
        base, n = key, 2
        while key in seen:
            key, n = f"{base}-{n}", n + 1
        seen.add(key)
        roots.append(Root(key, label, Path(path), _parse_local(item.get("local"), i)))
    return roots or _parse_roots(DEFAULT_ROOTS)


def _config() -> tuple[list[Root], int]:
    settings = _settings()
    try:
        cap = int(settings.get("max_entries") or DEFAULT_MAX_ENTRIES)
    except (TypeError, ValueError):
        cap = DEFAULT_MAX_ENTRIES
    return _parse_roots(settings.get("roots")), max(50, min(cap, 20000))


def _root(roots: list[Root], key: str) -> Root:
    if not key:
        return roots[0]
    for r in roots:
        if r.key == key:
            return r
    raise HTTPException(status_code=404, detail="unknown root")


def _resolve(root: Path, rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    target = (root / rel).resolve()
    real_root = root.resolve()
    if target != real_root and real_root not in target.parents:
        raise HTTPException(status_code=400, detail="outside root")
    return target


@router.get("/roots")
def roots():
    configured, _cap = _config()
    return {"roots": [{"key": r.key, "label": r.label, "root": str(r.path), "local": r.local}
                      for r in configured]}


@router.get("/root")
def root_info(root: str = ""):
    r = _root(_config()[0], root)
    return {"root": str(r.path), "exists": r.path.is_dir()}


@router.get("/list")
def list_dir(path: str = "", hidden: bool = False, root: str = ""):
    configured, cap = _config()
    base = _root(configured, root).path
    target = _resolve(base, path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a folder")
    dirs: list[str] = []
    files: list[os.DirEntry] = []
    dead: set[str] = set()
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
                    # A symlink whose target is missing here (often a relative
                    # link pointing outside a network mount) is not a file.
                    try:
                        if e.is_symlink() and not os.path.exists(e.path):
                            dead.add(e.name)
                    except OSError:
                        pass
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")

    # Sort and cap after collecting everything, so truncation only ever drops
    # trailing files, never folders. stat() only the files that are returned.
    dirs.sort(key=str.lower)
    files.sort(key=lambda e: e.name.lower())
    room = max(cap - len(dirs), 0)
    truncated = len(dirs) + len(files) > cap
    entries = [{"name": n, "dir": True, "size": None} for n in dirs[:cap]]
    for e in files[:room]:
        if e.name in dead:
            entries.append({"name": e.name, "dir": False, "size": None, "link": "broken"})
            continue
        try:
            size = e.stat().st_size
        except OSError:
            size = None
        entries.append({"name": e.name, "dir": False, "size": size})

    real_root = base.resolve()
    rel = "" if target == real_root else target.relative_to(real_root).as_posix()
    return {
        "root": str(base),
        "path": rel,
        # Built from the mount, not the resolved target, so inserted paths stay
        # under the mount point even if it is a symlink.
        "abs": f"{base.as_posix()}/{rel}" if rel else base.as_posix(),
        "entries": entries,
        "truncated": truncated,
    }
