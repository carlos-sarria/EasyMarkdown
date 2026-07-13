# EasyMarkdown

A lightweight, cross-platform Markdown viewer built with **Tauri v2** (Rust backend) and a **vanilla JS + Vite** frontend. No framework, no Electron overhead — the OS's native WebView renders the frontend.

---

## Goals

- View `.md` files quickly, with zero editing features
- Native desktop app feel (window, OS file association, drag & drop)
- Small binary (~5–10 MB via Tauri vs ~150 MB Electron)
- Cross-platform: Windows (WebView2/Edge), macOS (WKWebView), Linux (WebKitGTK)

---

## Features

- **Multiple tabs** — open several Markdown files at once; tabs persist across sessions.
- **Recent files** — quick access to the last 10 opened files from the actions drawer.
- **Auto-refresh** — detects when the active file changes on disk and updates the preview while preserving scroll position.
- **Single-instance** — opening a file from the OS while the app is already running forwards it to the existing window.
- **Dark / light theme** — manual toggle with OS-preference fallback; persisted in `localStorage`.
- **Local images** — relative image references are resolved and rendered from disk.
- **Drag and drop** — drop `.md` files (or any file) onto the window to open them.
- **Print** — print the currently rendered document.
- **Keyboard shortcuts** — `Ctrl+O` open, `Ctrl+W` close tab, `Ctrl+F` search, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs.

---

## Repository layout

```
EasyMarkdown/
├── index.html              # App shell — loaded by Tauri's WebView
├── package.json            # JS dependencies and npm scripts
├── vite.config.js          # Vite bundler config (Tauri v2 standard)
├── README.md               # This file
├── src/
│   ├── main.js             # All frontend logic (single entry point)
│   └── styles.css          # All styles (CSS custom properties, no preprocessor)
└── src-tauri/              # Rust/Tauri project
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/
    │   └── default.json    # Tauri capability grants (permissions)
    ├── icons/              # Application and file-association icons
    ├── svg/                # Toolbar / drawer icon assets
    └── src/
        ├── lib.rs          # Tauri builder, plugin registration, commands, single-instance IPC
        └── main.rs         # Binary entry point
```

---

## Frontend architecture

The frontend is a single-page application with no routing. State is kept in module-level variables in `src/main.js`.

### Rendering pipeline

```
File path (string)
  └─→ readTextFile()          [tauri-plugin-fs]
        └─→ marked.parse()    [marked v13, GFM enabled]
              └─→ pre/code highlighting
                    └─→ hljs.highlight() / highlightAuto()   [highlight.js v11]
                          └─→ innerHTML of #markdown-body
```

Local images referenced by Markdown are resolved relative to the document path, read via `readFile()`, and displayed through temporary `blob:` URLs.

### UI states

The app has two mutually exclusive visible states managed by toggling the `.hidden` class:

| State | Visible elements |
|-------|-----------------|
| No file open | `#welcome` |
| File loaded | `#markdown-body`, `#tabs-bar` |

The `#drop-overlay`, `#error-banner`, and `#about-modal` are overlays that can appear on top of either state. The actions `#drawer-panel` slides open from the toolbar menu button.

### Theming

Dark/light mode is controlled by a `data-theme` attribute on `<html>`:

- `data-theme="light"` (default) — uses `:root` CSS variables
- `data-theme="dark"` — uses `[data-theme="dark"]` overrides

All colours are CSS custom properties defined in `src/styles.css`. There are no hard-coded colour values outside of the `:root` / `[data-theme="dark"]` blocks.

The highlight.js code theme is handled separately: both `github.css` (light) and `github-dark.css` (dark) are imported as inline strings via Vite's `?inline` suffix and injected into a dynamically created `<style>` element. This avoids a flash of unstyled code on theme switch.

Theme preference is persisted in `localStorage` under the key `easymd-theme`. If no preference is saved, the OS colour-scheme media query (`prefers-color-scheme`) is used.

### Drag and drop

File drag-and-drop is handled via Tauri's native webview event, **not** the HTML5 `dragover`/`drop` events. This is required because Tauri intercepts native file drops before the browser engine sees them.

```js
getCurrentWebview().onDragDropEvent((event) => { ... })
```

Event payload `.type` values: `'over'`, `'drop'`, `'leave'`, `'cancel'`.  
On `'drop'`, `event.payload.paths` is a `string[]` of dropped file paths. Markdown files are opened as tabs; if only non-Markdown files are dropped, the first one is opened.

---

## JS ↔ Rust interface

### Custom commands (JS → Rust, via `invoke`)

| Command | Return type | Description |
|---------|------------|-------------|
| `get_initial_file` | `string \| null` | Returns the file path captured from `argv[1]` at startup (CLI arg or OS file association), then clears it. Called once in `init()`. |
| `path_exists` | `boolean` | Returns `true` if the given filesystem path exists. Used by auto-refresh to mark stale tabs. |
| `save_tabs` | — | Persists the ordered list of currently open tab paths to `tabs.json` in the app data directory. |
| `load_tabs` | `string[]` | Restores the previously saved list of open tab paths. |
| `save_recent` | — | Persists the recent files list to `recent.json`. |
| `load_recent` | `string[]` | Restores the previously saved recent files list. |

### Events (Rust → JS)

| Event name | Payload type | Description |
|------------|-------------|-------------|
| `file-opened` | `string` | Emitted when a secondary instance forwards a file path to the primary instance. The frontend opens the path as a new tab. |

### Tauri plugin APIs used directly from JS

| JS import | Plugin | Rust registration |
|-----------|--------|------------------|
| `open` from `@tauri-apps/plugin-dialog` | `tauri-plugin-dialog` | `.plugin(tauri_plugin_dialog::init())` |
| `readTextFile`, `readFile` from `@tauri-apps/plugin-fs` | `tauri-plugin-fs` | `.plugin(tauri_plugin_fs::init())` |
| `openPath`, `openUrl` from `@tauri-apps/plugin-opener` | `tauri-plugin-opener` | `.plugin(tauri_plugin_opener::init())` |

---

## Rust-side setup requirements

These are the minimum changes needed in `src-tauri/` to wire up the frontend.

### `Cargo.toml`

```toml
[dependencies]
tauri              = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs     = "2"
tauri-plugin-opener = "2"
serde      = { version = "1", features = ["derive"] }
serde_json = "1"
```

### `src/lib.rs`

Already written — see `src-tauri/src/lib.rs`. Key pieces:

```rust
use std::sync::Mutex;

pub struct AppState { pub initial_file: Mutex<Option<String>> }

#[tauri::command]
fn get_initial_file(state: tauri::State<'_, AppState>) -> Option<String> {
    state.initial_file.lock().unwrap().take() // consumed once
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn save_tabs(app: tauri::AppHandle, paths: Vec<String>) { /* ... */ }

#[tauri::command]
fn load_tabs(app: tauri::AppHandle) -> Vec<String> { /* ... */ }

#[tauri::command]
fn save_recent(app: tauri::AppHandle, paths: Vec<String>) { /* ... */ }

#[tauri::command]
fn load_recent(app: tauri::AppHandle) -> Vec<String> { /* ... */ }
```

The library also implements single-instance behaviour via a localhost TCP socket (`IPC_PORT = 34982`). A secondary instance forwards its `argv[1]` path to the primary instance and exits; the primary emits a `file-opened` event to open the file as a new tab.

### `capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for EasyMarkdown.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "opener:default",
    {
      "identifier": "opener:allow-open-url",
      "allow": [
        { "url": "http://*" },
        { "url": "https://*" },
        { "url": "mailto:*" },
        { "url": "tel:*" }
      ]
    },
    {
      "identifier": "opener:allow-open-path",
      "allow": [{ "path": "**" }]
    },
    {
      "identifier": "fs:allow-read-text-file",
      "allow": [{"path": "**"}]
    },
    {
      "identifier": "fs:allow-read-file",
      "allow": [{"path": "**"}]
    }
  ]
}
```

### `tauri.conf.json` (key fields)

```json
{
  "build": {
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "label": "main",
      "title": "EasyMarkdown v1.0.0",
      "width": 1200,
      "height": 800,
      "minWidth": 600,
      "minHeight": 400,
      "center": true,
      "resizable": true,
      "decorations": true,
      "dragDropEnabled": true
    }]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "fileAssociations": [
      {
        "ext": ["md", "markdown", "mkd", "mdown"],
        "name": "Markdown",
        "description": "Markdown document",
        "role": "Viewer"
      }
    ]
  }
}
```

---

## JS dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@tauri-apps/api` | ^2 | Core Tauri JS API (events, webview) |
| `@tauri-apps/plugin-dialog` | ^2 | OS file-open dialog |
| `@tauri-apps/plugin-fs` | ^2 | Read files from the local filesystem |
| `@tauri-apps/plugin-opener` | ^2.5.4 | Open local paths and external URLs |
| `marked` | ^13 | Markdown → HTML parser (GFM-compliant) |
| `highlight.js` | ^11 | Syntax highlighting for fenced code blocks |
| `vite` | ^6 | Dev server + bundler (devDep) |
| `@tauri-apps/cli` | ^2.11.4 | `npm run tauri` shortcut (devDep) |

---

## Development workflow

```bash
# Install JS dependencies
npm install

# Frontend-only dev server (no Rust, useful for UI work)
npm run dev

# Full Tauri dev build (starts Vite + compiles Rust + opens window)
npm run tauri dev

# Production build
npm run tauri build
```

The Vite dev server listens on **port 1420** (hardcoded in `vite.config.js`). Tauri's `devUrl` must match this.

---

## Create/Update Icons

From the project root:

```bash
cargo tauri icon src-tauri/svg/EasyMD.svg
```

---

## Key design decisions

**Vanilla JS, no framework.** The app has one screen and no routing. React/Vue would add meaningful complexity and bundle size for little benefit here.

**Plugin APIs used directly.** The frontend uses `plugin-dialog`, `plugin-fs`, and `plugin-opener` directly. Custom Rust commands are reserved for persistence and startup-file handling.

**`?inline` CSS import for highlight.js themes.** Importing CSS as a string allows runtime theme swapping without DOM `<link>` manipulation, which would require special Vite config and risks a flash of unstyled content.

**`data-tauri-drag-region` on the toolbar.** When `decorations: false` is set in `tauri.conf.json` (custom titlebar), the toolbar becomes the window drag handle. With default decorations this attribute is inert but harmless.

---

## Adding features — extension points

**File watching / auto-reload:** Add `tauri-plugin-fs` watch API on the Rust side. On file change, emit a `file-changed` event; the frontend's `reloadFile()` function is already wired to `Ctrl+R` and the ↺ button and can be called from a new event listener.

**Recent files:** Store paths in `localStorage` under a key like `easymd-recent` (array of strings). Show them on the welcome screen.

**Print / export to PDF:** Use `window.print()` — browsers/WebView support this natively. Add a print-specific `@media print` stylesheet to hide the toolbar.

**Table of contents:** Walk `#markdown-body` for heading elements after `renderMarkdown()` and build a floating `<nav>` panel.

**OS file association (open `.md` files with EasyMD):** Handled entirely in `tauri.conf.json` under `"fileAssociations"` — no frontend changes needed.

**Custom CSS themes:** Add a `data-theme="<name>"` block in `styles.css` and a theme-selector UI. The hljs theme swap is already abstracted in `applyTheme()` in `main.js`.
