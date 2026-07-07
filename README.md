# EasyMD

A lightweight, cross-platform Markdown viewer built with **Tauri v2** (Rust backend) and a **vanilla JS + Vite** frontend. No framework, no Electron overhead — the OS's native WebView renders the frontend.

---

## Goals

- View `.md` files quickly, with zero editing features
- Native desktop app feel (window, OS file association, drag & drop)
- Small binary (~5–10 MB via Tauri vs ~150 MB Electron)
- Cross-platform: Windows (WebView2/Edge), macOS (WKWebView), Linux (WebKitGTK)

---

## Repository layout

```
EasyMD/
├── index.html              # App shell — loaded by Tauri's WebView
├── package.json            # JS dependencies and npm scripts
├── vite.config.js          # Vite bundler config (Tauri v2 standard)
├── src/
│   ├── main.js             # All frontend logic (single entry point)
│   └── styles.css          # All styles (CSS custom properties, no preprocessor)
└── src-tauri/              # Rust/Tauri project (NOT created by this frontend)
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json    # Tauri capability grants (permissions)
    └── src/
        └── lib.rs          # Tauri builder, plugin registration, startup logic
```

---

## Frontend architecture

The entire frontend is a single-page application with no routing. State is minimal and kept in module-level variables in `src/main.js`.

### Rendering pipeline

```
File path (string)
  └─→ readTextFile()          [tauri-plugin-fs]
        └─→ marked.parse()    [marked v13, GFM enabled]
              └─→ renderer.code() hook
                    └─→ hljs.highlight() / highlightAuto()   [highlight.js v11]
                          └─→ innerHTML of #markdown-body
```

### UI states

The app has two mutually exclusive visible states managed by toggling the `.hidden` class:

| State | Visible elements |
|-------|-----------------|
| No file open | `#welcome` |
| File loaded | `#markdown-body`, `#btn-reload` in toolbar |

The `#drop-overlay` and `#error-banner` are overlays that can appear on top of either state.

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
On `'drop'`, `event.payload.paths` is a `string[]` of dropped file paths.

---

## JS ↔ Rust interface

This is the contract between the frontend and the Rust backend. **Both sides must agree on these names and payload shapes.**

### Custom commands (JS → Rust, via `invoke`)

| Command | Return type | Description |
|---------|------------|-------------|
| `get_initial_file` | `string \| null` | Returns the file path captured from `argv[1]` at startup (CLI arg or OS file association), then clears it. Subsequent calls return `null`. Called once in `init()`. |

Frontend calls with:
```js
import { invoke } from '@tauri-apps/api/core';
const path = await invoke('get_initial_file'); // string | null
if (path) loadFile(path);
```

Rust-side implementation is in `src-tauri/src/lib.rs` — see `get_initial_file` and `AppState`.

### Events (Rust → JS)

| Event name | Payload type | Description |
|------------|-------------|-------------|
| `file-opened` | `string` | Reserved for future use (e.g. file-watcher, re-open from tray). The frontend has a listener registered. Payload must be an absolute file path string. |

### Tauri plugin APIs used directly from JS

The frontend calls Tauri plugin APIs directly (no custom Rust wrapper needed):

| JS import | Plugin | Rust registration |
|-----------|--------|------------------|
| `open` from `@tauri-apps/plugin-dialog` | `tauri-plugin-dialog` | `.plugin(tauri_plugin_dialog::init())` |
| `readTextFile` from `@tauri-apps/plugin-fs` | `tauri-plugin-fs` | `.plugin(tauri_plugin_fs::init())` |

---

## Rust-side setup requirements

These are the minimum changes needed in `src-tauri/` to wire up the frontend.

### `Cargo.toml`

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
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

pub fn run() {
    let initial_file = std::env::args().nth(1)
        .filter(|p| std::path::Path::new(p).exists());

    tauri::Builder::default()
        .manage(AppState { initial_file: Mutex::new(initial_file) })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_initial_file])
        .run(tauri::generate_context!())
        .expect("error while running EasyMD");
}
```

### `capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-text-file"
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
      "title": "EasyMD",
      "width": 1024,
      "height": 768,
      "decorations": true,
      "dragDropEnabled": true
    }]
  }
}
```

`dragDropEnabled: true` is **required** for the native drag-and-drop to work.

---

## JS dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@tauri-apps/api` | ^2 | Core Tauri JS API (events, webview) |
| `@tauri-apps/plugin-dialog` | ^2 | OS file-open dialog |
| `@tauri-apps/plugin-fs` | ^2 | Read files from the local filesystem |
| `marked` | ^13 | Markdown → HTML parser (GFM-compliant) |
| `highlight.js` | ^11 | Syntax highlighting for fenced code blocks |
| `vite` | ^6 | Dev server + bundler (devDep) |
| `@tauri-apps/cli` | ^2 | `npm run tauri` shortcut (devDep) |

---

## Development workflow

```bash
# Install JS dependencies
npm install

# Frontend-only dev server (no Rust, useful for UI work)
npm run dev

# Full Tauri dev build (starts Vite + compiles Rust + opens window)
cargo tauri dev          # from src-tauri/
# or
npm run tauri -- dev     # from project root

# Production build
npm run tauri -- build
```

The Vite dev server listens on **port 1420** (hardcoded in `vite.config.js`). Tauri's `devUrl` must match this.


## Create/Update Icons

From the project root

```bash
cargo tauri icon C:\dev\Applications\EasyMD\src-tauri\icons\EasyMD.png
```
---

## Key design decisions

**Vanilla JS, no framework.** The app has one screen, one file at a time, and no routing. React/Vue would add ~100 KB and meaningful complexity for zero benefit here.

**No custom Tauri `invoke()` commands.** The frontend uses the plugin APIs directly (`plugin-dialog`, `plugin-fs`). This keeps the Rust side minimal — it only needs to register the plugins and handle the startup file argument.

**`?inline` CSS import for highlight.js themes.** Importing CSS as a string allows runtime theme swapping without DOM `<link>` manipulation, which would require special Vite config and risks a flash of unstyled content.

**`color-mix()` for the drop overlay tint.** Requires Chrome 111+ / Edge 111+, which Tauri on Windows (WebView2) satisfies. If targeting older WebView2, replace with a hard-coded RGBA fallback.

**`data-tauri-drag-region` on the toolbar.** When `decorations: false` is set in `tauri.conf.json` (custom titlebar), the toolbar becomes the window drag handle. With default decorations this attribute is inert but harmless.

---

## Adding features — extension points

**File watching / auto-reload:** Add `tauri-plugin-fs` watch API on the Rust side. On file change, emit a `file-changed` event; the frontend's `reloadFile()` function is already wired to `Ctrl+R` and the ↺ button and can be called from a new event listener.

**Recent files:** Store paths in `localStorage` under a key like `easymd-recent` (array of strings). Show them on the welcome screen.

**Print / export to PDF:** Use `window.print()` — browsers/WebView support this natively. Add a print-specific `@media print` stylesheet to hide the toolbar.

**Table of contents:** Walk `#markdown-body` for heading elements after `renderMarkdown()` and build a floating `<nav>` panel.

**OS file association (open `.md` files with EasyMD):** Handled entirely in `tauri.conf.json` under `"fileAssociations"` — no frontend changes needed.

**Custom CSS themes:** Add a `data-theme="<name>"` block in `styles.css` and a theme-selector UI. The hljs theme swap is already abstracted in `applyTheme()` in `main.js`.
