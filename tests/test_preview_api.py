import base64
from pathlib import Path
from types import SimpleNamespace

import pytest

from dashboard import plugin_api


class FakeHTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


def configure_root(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    root.mkdir()
    monkeypatch.setattr(plugin_api, "HTTPException", FakeHTTPException)
    monkeypatch.setattr(plugin_api, "_config", lambda: ([SimpleNamespace(key="test", path=root)], 2000))


@pytest.mark.parametrize("name,media_type", [
    ("sample.pdf", "application/pdf"),
    ("sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("sample.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
])
def test_preview_returns_original_bytes_without_mutation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, media_type: str) -> None:
    root = tmp_path / "root"
    configure_root(monkeypatch, root)
    original = b"synthetic fixture: " + name.encode()
    (root / name).write_bytes(original)
    before = (root / name).read_bytes()

    result = plugin_api.preview_file(name, "test")

    assert result == {"content": base64.b64encode(original).decode("ascii"), "media_type": media_type}
    assert (root / name).read_bytes() == before


def test_preview_rejects_unsupported_extension(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "root"
    configure_root(monkeypatch, root)
    with pytest.raises(FakeHTTPException) as exc:
        plugin_api.preview_file("notes.txt", "test")
    assert exc.value.status_code == 415


def test_preview_rejects_symlink_escape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "root"
    configure_root(monkeypatch, root)
    secret = tmp_path / "outside.pdf"
    secret.write_bytes(b"not readable through root")
    (root / "escape.pdf").symlink_to(secret)
    with pytest.raises(FakeHTTPException) as exc:
        plugin_api.preview_file("escape.pdf", "test")
    assert exc.value.status_code == 400


def test_preview_enforces_size_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "root"
    configure_root(monkeypatch, root)
    (root / "large.pdf").write_bytes(b"x" * (plugin_api.MAX_PREVIEW_BYTES + 1))
    with pytest.raises(FakeHTTPException) as exc:
        plugin_api.preview_file("large.pdf", "test")
    assert exc.value.status_code == 413
