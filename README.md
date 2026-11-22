# drive-pane

Hermes Desktop plugin: a **Drive** tab in the right sidebar with stacked, read-only
file browsers for folders on the gateway host, regardless of which chat is focused.
By default it shows:

- **Google Drive**: the Drive mirror at `/mnt/google-drive`
- **Uranium**: Unraid's user shares at `/mnt/uranium` (read-only sshfs of `/mnt/user`)

Drag a divider to resize the sections on either side of it (double-click resets them
all to even sizes). Click a folder to open it, click a file to insert its full path
into the focused chat's composer. `.*` toggles hidden files per section. Links that
point outside a root (Unraid's `docker`, `system`, ... are relative symlinks) show
dimmed as `link`.

## Right-click menu

On a file or folder, or on empty space for the folder being shown:

- **Open on this computer**: opens the item on the desktop machine with its default
  app (a PDF opens in Acrobat, a folder opens in Explorer/Finder)
- **Show in Explorer / Finder / file manager**: reveals and selects the item
- **Insert path in chat**, **Copy path** (the gateway path), **Copy local path**

The two "this computer" actions need the root's `local` mapping, the place the same
files appear on the desktop machine (usually an SMB share). Without one they are
greyed out with the reason.

## Configuration

Settings > Plugins > drive-pane, or `plugins.entries.drive-pane.settings` in
config.yaml. The defaults:

```yaml
plugins:
  entries:
    drive-pane:
      settings:
        roots:
          - label: Google Drive
            path: /mnt/google-drive
            key: drive
            local:
              windows: {"": '\\plutonium\CloudBackup\Google'}
          - label: Uranium
            path: /mnt/uranium
            key: uranium
            local:
              windows: {media: '\\192.168.250.135\media'}   # only media is shared over SMB
        max_entries: 2000
```

- `roots`: up to 8 sections, top to bottom. `path` (on the gateway) must be absolute.
  `key` is optional (derived from the label) and keeps each section's remembered folder
  and size stable across renames. A bare path string also works. Invalid entries are
  skipped; an empty or invalid list falls back to the defaults.
- `local`: per OS (`windows`, `macos`, `linux`), a map of subfolder prefix to local path.
  `""` maps the whole root, and the longest matching prefix wins. An OS value can be a
  plain string (the whole root), and `local` itself can be a string (every OS).
  macOS example: `macos: {"": /Volumes/Google}`.
- `max_entries`: per-folder cap (50 to 20000). Folders are always listed first.

The backend re-reads the settings on every request. The pane picks up changes when the
window regains focus or when you press a section's refresh.

## Building the desktop plugin

The checked-in `desktop/plugin.js` is built from `desktop/plugin.src.js` with pinned local dependencies. The Desktop loader still resolves only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`; the DOCX and XLSX renderer code is bundled into the plugin, with no CDN or runtime package installation.

Rebuild reproducibly with Node.js and npm:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:bundle
```

- `dashboard/plugin_api.py`: read-only listing routes at `/api/plugins/drive-pane/`
  (`/roots`, `/list?root=<key>&path=...`). A request names a root by key, never by
  path, so only configured folders are reachable.
- `plugin.yaml`: `config_schema` for the settings form
