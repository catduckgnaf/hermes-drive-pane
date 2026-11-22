# drive-pane

Hermes Desktop plugin: a **Drive** tab in the right sidebar with stacked, read-only
file browsers for folders on the gateway host, regardless of which chat is focused.
By default it shows:

- **Configured roots**: directories selected by the operator; examples use synthetic paths

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
config.yaml. Configure roots for your gateway host. The public defaults are generic:

```yaml
plugins:
  entries:
    drive-pane:
      settings:
        roots:
          - label: Files
            path: /srv/files
            key: files
            local:
              windows: {"": "<server>\\<share>"}
        max_entries: 2000
```

Before upgrading an existing installation, copy its current root paths and desktop
`local` mappings into the operator-owned Hermes config (`config.yaml` or Settings >
Plugins). Do not commit that config or put site-specific values in this repository.
The plugin does not migrate private paths automatically. The backend re-reads settings
on every request; the pane picks up changes when the window regains focus or when you
press a section's refresh.

- `roots`: up to 8 sections, top to bottom. `path` (on the gateway) must be absolute.
  `key` is optional (derived from the label) and keeps each section's remembered folder
  and size stable across renames. A bare path string also works. Invalid entries are
  skipped; an empty or invalid list falls back to the generic defaults.
- `local`: per OS (`windows`, `macos`, `linux`), a map of subfolder prefix to local path.
  `""` maps the whole root, and the longest matching prefix wins. An OS value can be a
  plain string (the whole root), and `local` itself can be a string (every OS).
  Example: `macos: {"": /Volumes/share}`.
- `max_entries`: per-folder cap (50 to 20000). Folders are always listed first.

## Layout

- `desktop/plugin.js`: the pane (desktop half)
- `dashboard/plugin_api.py`: read-only listing routes at `/api/plugins/drive-pane/`
  (`/roots`, `/list?root=<key>&path=...`). A request names a root by key, never by
  path, so only configured folders are reachable.
- `plugin.yaml`: `config_schema` for the settings form
