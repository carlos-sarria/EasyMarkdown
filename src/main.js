/**
 * EasyMD — main.js
 *
 * ── Rust-side requirements ────────────────────────────────────────────────
 *
 *  Plugins (Cargo.toml + lib.rs):
 *    tauri-plugin-dialog  →  tauri::Builder::register_plugin(tauri_plugin_dialog::init())
 *    tauri-plugin-fs      →  tauri::Builder::register_plugin(tauri_plugin_fs::init())
 *
 *  Capabilities (src-tauri/capabilities/default.json):
 *    "dialog:allow-open"
 *    "fs:allow-read-text-file"
 *    "fs:allow-read-file"          // some versions need this too
 *
 *  CLI / OS file association (argv[1] → initial file):
 *    lib.rs reads std::env::args().nth(1), stores it in AppState, and exposes
 *    it via the `get_initial_file` command. The frontend calls this command
 *    in init() — no timing race, consumed once.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { invoke }              from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile }        from '@tauri-apps/plugin-fs';
import { listen }              from '@tauri-apps/api/event';
import { getCurrentWebview }   from '@tauri-apps/api/webview';
import { marked }              from 'marked';
import hljs                    from 'highlight.js';

// highlight.js themes imported as inline strings so we can swap at runtime
// without a <link> swap (avoids FOUC and works fully offline).
import lightTheme from 'highlight.js/styles/github.css?inline';
import darkTheme  from 'highlight.js/styles/github-dark.css?inline';

// ── Marked setup ──────────────────────────────────────────────────────────

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Syntax-highlight fenced code blocks via highlight.js
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      const highlighted = language
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
      const cls = language ? `hljs language-${language}` : 'hljs';
      return `<pre><code class="${cls}">${highlighted}</code></pre>`;
    },
  },
});

// ── State ─────────────────────────────────────────────────────────────────

/** Whether the dark theme is active. Defaults to the OS preference. */
let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Absolute path of the currently open file, or null. */
let currentFilePath = null;

// ── DOM refs ──────────────────────────────────────────────────────────────

const elHtml          = document.documentElement;
const elFilePath      = document.getElementById('file-path');
const elWelcome       = document.getElementById('welcome');
const elMarkdownBody  = document.getElementById('markdown-body');
const elDropOverlay   = document.getElementById('drop-overlay');
const elErrorBanner   = document.getElementById('error-banner');
const elErrorMessage  = document.getElementById('error-message');
const elBtnOpen       = document.getElementById('btn-open');
const elBtnOpenWelcome= document.getElementById('btn-open-welcome');
const elBtnReload     = document.getElementById('btn-reload');
const elBtnTheme      = document.getElementById('btn-theme');
const elBtnDismiss    = document.getElementById('btn-error-dismiss');
const elContent       = document.getElementById('content');

// ── highlight.js theme injection ─────────────────────────────────────────

const hljsStyleEl = document.createElement('style');
document.head.appendChild(hljsStyleEl);

// ── Theme management ──────────────────────────────────────────────────────

function applyTheme() {
  elHtml.dataset.theme     = isDark ? 'dark' : 'light';
  hljsStyleEl.textContent  = isDark ? darkTheme : lightTheme;
  elBtnTheme.textContent   = isDark ? '☀️' : '🌙';
  elBtnTheme.title         = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
  isDark = !isDark;
  applyTheme();
  // Persist preference
  localStorage.setItem('easymd-theme', isDark ? 'dark' : 'light');
}

// Restore saved preference if any
const savedTheme = localStorage.getItem('easymd-theme');
if (savedTheme) isDark = savedTheme === 'dark';
applyTheme();

// ── Error handling ────────────────────────────────────────────────────────

function showError(msg) {
  elErrorMessage.textContent = msg;
  elErrorBanner.classList.remove('hidden');
}

function hideError() {
  elErrorBanner.classList.add('hidden');
}

// ── File operations ───────────────────────────────────────────────────────

const MD_EXTENSIONS = /\.(md|markdown|mkd|mdown|mdx|txt)$/i;

/**
 * Open the OS file-picker dialog and load the chosen file.
 */
async function pickAndOpenFile() {
  try {
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mkd', 'mdown', 'mdx'] },
        { name: 'Text',     extensions: ['txt'] },
        { name: 'All',      extensions: ['*'] },
      ],
    });
    if (selected) await loadFile(/** @type {string} */ (selected));
  } catch (err) {
    showError(`Could not open file: ${err}`);
  }
}

/**
 * Read a file from disk and render it.
 * @param {string} path  Absolute file path
 */
async function loadFile(path) {
  hideError();
  try {
    const content = await readTextFile(path);
    currentFilePath = path;
    renderMarkdown(content, path);
  } catch (err) {
    showError(`Failed to read "${path}": ${err}`);
  }
}

/**
 * Reload the currently open file from disk (useful for live editing).
 */
async function reloadFile() {
  if (currentFilePath) await loadFile(currentFilePath);
}

/**
 * Parse markdown and update the DOM.
 * @param {string} content  Raw markdown text
 * @param {string} path     File path (used for title / display)
 */
function renderMarkdown(content, path) {
  elMarkdownBody.innerHTML = marked.parse(content);

  // Show markdown, hide welcome
  elMarkdownBody.classList.remove('hidden');
  elWelcome.classList.add('hidden');
  elBtnReload.classList.remove('hidden');

  // Scroll back to top
  elContent.scrollTop = 0;

  // Update toolbar path display (show only the filename, full path in tooltip)
  const filename = path.replace(/\\/g, '/').split('/').pop();
  elFilePath.textContent = filename ?? path;
  elFilePath.title       = path;

  // Update window title
  document.title = `${filename} — EasyMD`;
}

// ── Event listeners ───────────────────────────────────────────────────────

elBtnOpen.addEventListener('click', pickAndOpenFile);
elBtnOpenWelcome.addEventListener('click', pickAndOpenFile);
elBtnReload.addEventListener('click', reloadFile);
elBtnTheme.addEventListener('click', toggleTheme);
elBtnDismiss.addEventListener('click', hideError);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'o') { e.preventDefault(); pickAndOpenFile(); }
  if (mod && e.key === 'r') { e.preventDefault(); reloadFile(); }
});

// OS colour-scheme change → update if the user hasn't set a manual preference
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('easymd-theme')) {
    isDark = e.matches;
    applyTheme();
  }
});

// ── Async initialisation ──────────────────────────────────────────────────

async function init() {
  // 1. Drag-and-drop via Tauri webview event (handles native file drops).
  //    The overlay provides visual feedback while dragging over the window.
  try {
    const webview = getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      const { type } = event.payload;

      if (type === 'over') {
        elDropOverlay.classList.remove('hidden');
      } else if (type === 'leave' || type === 'cancel') {
        elDropOverlay.classList.add('hidden');
      } else if (type === 'drop') {
        elDropOverlay.classList.add('hidden');
        const paths = event.payload.paths ?? [];
        const mdFile = paths.find((p) => MD_EXTENSIONS.test(p)) ?? paths[0];
        if (mdFile) loadFile(mdFile).catch((err) => showError(String(err)));
      }
    });
  } catch (err) {
    // Drag-and-drop is a nice-to-have; don't block startup if it fails.
    console.warn('Drag-and-drop setup failed:', err);
  }

  // 2. Listen for a "file-opened" event emitted by Rust on startup
  //    (e.g. when the app is launched with a file path as a CLI argument,
  //    or when the OS opens the app via file association).
  //    Expected payload: a string containing the absolute file path.
  await listen('file-opened', (event) => {
    const path = event.payload;
    if (typeof path === 'string' && path.trim()) {
      loadFile(path).catch((err) => showError(String(err)));
    }
  });

  // 3. Ask Rust for the file path passed via CLI arg or OS file association.
  //    Using a command (not an event) avoids the timing race of emitting
  //    before this listener is registered. The value is consumed once.
  const initialPath = await invoke('get_initial_file').catch(() => null);
  if (typeof initialPath === 'string' && initialPath.trim()) {
    await loadFile(initialPath);
  }
}

init().catch(console.error);
