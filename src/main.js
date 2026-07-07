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
});

// ── State ─────────────────────────────────────────────────────────────────

/** Whether the dark theme is active. Defaults to the OS preference. */
let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * Currently open tabs.
 * @type {{ path: string, html: string, filename: string }[]}
 */
let tabs = [];

/** Index into tabs[]; -1 when no files are open. */
let activeIndex = -1;

// ── DOM refs ──────────────────────────────────────────────────────────────

const elHtml          = document.documentElement;
const elTabs          = document.getElementById('tabs');
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

// ── Utility ───────────────────────────────────────────────────────────────

/** Escape HTML entities so filenames/titles don't break the tab DOM. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Markdown parsing ──────────────────────────────────────────────────────

/**
 * Parse raw markdown text into highlighted HTML.
 * Pure function — no DOM side effects.
 * @param {string} content
 * @returns {string}
 */
function parseMarkdown(content) {
  let html;
  try {
    html = marked.parse(content);
  } catch (err) {
    throw new Error(`Markdown parse error: ${err}`);
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('pre code').forEach((block) => {
    const langClass = Array.from(block.classList).find((c) =>
      c.startsWith('language-')
    );
    const lang = langClass ? langClass.replace('language-', '') : '';
    const text = block.textContent;

    if (text) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      block.innerHTML = language
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
      block.classList.add('hljs');
      if (language) block.classList.add(`language-${language}`);
    }
  });
  return tmp.innerHTML;
}

// ── Tab management ────────────────────────────────────────────────────────

/** Rebuild the tab bar DOM from the `tabs` array. */
function renderTabs() {
  if (tabs.length === 0) { elTabs.innerHTML = ''; return; }

  elTabs.innerHTML = tabs
    .map(
      (t, i) =>
        `<div class="tab${i === activeIndex ? ' active' : ''}" data-index="${i}" title="${escapeHtml(t.path)}">
          <span class="tab-label">${escapeHtml(t.filename)}</span>
          <button class="tab-close" data-close="${i}">&times;</button>
        </div>`
    )
    .join('');

  // Scroll the active tab into view.
  const activeEl = elTabs.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Switch to the tab at `index` and update the viewport. */
function switchTab(index) {
  if (index < 0 || index >= tabs.length) return;
  activeIndex = index;
  const tab = tabs[index];

  elMarkdownBody.innerHTML = tab.html;
  elMarkdownBody.classList.remove('hidden');
  elWelcome.classList.add('hidden');
  elBtnReload.classList.remove('hidden');

  elContent.scrollTop = 0;
  document.title = `${tab.filename} — EasyMD`;
  elFilePath.textContent = tab.filename;
  elFilePath.title = tab.path;

  renderTabs();
}

/** Close the tab at `index` and switch to the nearest sibling. */
function closeTab(index) {
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    activeIndex = -1;
    showWelcome();
    return;
  }
  // Move to the neighbour closer to the end of the old list.
  const next = Math.min(index, tabs.length - 1);
  switchTab(next);
}

/** Show the welcome screen (no open files). */
function showWelcome() {
  elMarkdownBody.classList.add('hidden');
  elWelcome.classList.remove('hidden');
  elBtnReload.classList.add('hidden');
  elFilePath.textContent = '';
  elFilePath.title = '';
  document.title = 'EasyMD';
  renderTabs();
}

// ── File operations ───────────────────────────────────────────────────────

const MD_EXTENSIONS = /\.(md|markdown|mkd|mdown|mdx|txt)$/i;

/**
 * Read `path` from disk, parse to HTML, and open it as a tab.
 * If the file is already open it is refreshed and re-selected.
 * @param {string} path
 */
async function openFileAsTab(path) {
  hideError();
  try {
    const content = await readTextFile(path);
    const html = parseMarkdown(content);
    const filename = path.replace(/\\/g, '/').split('/').pop() ?? path;

    // Already open? Refresh content and switch to it.
    const existingIdx = tabs.findIndex((t) => t.path === path);
    if (existingIdx >= 0) {
      tabs[existingIdx] = { path, html, filename };
      switchTab(existingIdx);
      return;
    }

    // New tab.
    tabs.push({ path, html, filename });
    switchTab(tabs.length - 1);
  } catch (err) {
    showError(`Failed to read "${path}": ${err}`);
  }
}

/** Open the OS file-picker and open the selected file as a new tab. */
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
    if (selected) await openFileAsTab(/** @type {string} */ (selected));
  } catch (err) {
    showError(`Could not open file: ${err}`);
  }
}

/** Re-read the active tab's file from disk (useful for live-editing). */
async function reloadFile() {
  if (activeIndex >= 0) await openFileAsTab(tabs[activeIndex].path);
}

// ── Event listeners ───────────────────────────────────────────────────────

elBtnOpen.addEventListener('click', pickAndOpenFile);
elBtnOpenWelcome.addEventListener('click', pickAndOpenFile);
elBtnReload.addEventListener('click', reloadFile);
elBtnTheme.addEventListener('click', toggleTheme);
elBtnDismiss.addEventListener('click', hideError);

// Tab click delegation — switch to tab on click, close on × click.
elTabs.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.tab-close');
  if (closeBtn) {
    e.stopPropagation();
    const idx = parseInt(closeBtn.dataset.close, 10);
    if (!isNaN(idx)) closeTab(idx);
    return;
  }
  const tabEl = e.target.closest('.tab');
  if (tabEl) {
    const idx = parseInt(tabEl.dataset.index, 10);
    if (!isNaN(idx)) switchTab(idx);
  }
});

// Keyboard shortcuts.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'o') { e.preventDefault(); pickAndOpenFile(); return; }
  if (mod && e.key === 'r') { e.preventDefault(); reloadFile(); return; }
  if (mod && e.key === 'w') { e.preventDefault(); if (activeIndex >= 0) closeTab(activeIndex); return; }
  // Ctrl+Tab / Ctrl+Shift+Tab to cycle tabs.
  if (mod && e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    const dir = e.shiftKey ? -1 : 1;
    switchTab(((activeIndex + dir) % tabs.length + tabs.length) % tabs.length);
  }
});

// OS colour-scheme change → update if the user hasn't set a manual preference.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('easymd-theme')) {
    isDark = e.matches;
    applyTheme();
  }
});

// ── Async initialisation ──────────────────────────────────────────────────

async function init() {
  // 1. Drag-and-drop via Tauri webview event.
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
        if (mdFile) openFileAsTab(mdFile).catch((err) => showError(String(err)));
      }
    });
  } catch (err) {
    console.warn('Drag-and-drop setup failed:', err);
  }

  // 2. Listen for "file-opened" event (future use).
  await listen('file-opened', (event) => {
    const path = event.payload;
    if (typeof path === 'string' && path.trim()) {
      openFileAsTab(path).catch((err) => showError(String(err)));
    }
  });

  // 3. Ask Rust for the file path passed via CLI arg or OS file association.
  const initialPath = await invoke('get_initial_file').catch(() => null);
  if (typeof initialPath === 'string' && initialPath.trim()) {
    await openFileAsTab(initialPath);
  }
}

init().catch(console.error);
