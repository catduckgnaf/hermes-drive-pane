# drive-pane

Hermes Desktop plugin: a **Drive** tab in the right sidebar that always lists the
Google Drive mirror root (`/mnt/google-drive` on the gateway host), regardless of
which chat is focused. Read-only. Click a folder to open it, click a file to insert
its full path into the focused chat's composer. `.*` toggles hidden files.

- `desktop/plugin.js` — the pane (desktop half)
- `dashboard/plugin_api.py` — read-only listing routes at `/api/plugins/drive-pane/`
