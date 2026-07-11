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

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { openPath, openUrl }    from '@tauri-apps/plugin-opener';
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
const elTabsBar       = document.getElementById('tabs-bar');
const elFilePath      = document.getElementById('file-path');
const elWelcome       = document.getElementById('welcome');
const elMarkdownBody  = document.getElementById('markdown-body');
const elDropOverlay   = document.getElementById('drop-overlay');
const elErrorBanner   = document.getElementById('error-banner');
const elErrorMessage  = document.getElementById('error-message');
const elBtnOpen       = document.getElementById('btn-open');
const elBtnOpenWelcome= document.getElementById('btn-open-welcome');
const elBtnReload     = document.getElementById('btn-reload');
const elBtnPrint      = document.getElementById('btn-print');
const elBtnAbout      = document.getElementById('btn-about');
const elBtnTheme      = document.getElementById('btn-theme');
const elBtnMenu       = document.getElementById('btn-menu');
const elDrawerPanel   = document.getElementById('drawer-panel');
const elImgTheme      = document.getElementById('img_theme');
const elBtnDismiss    = document.getElementById('btn-error-dismiss');
const elContent       = document.getElementById('content');
const elAboutModal    = document.getElementById('about-modal');
const elAboutClose    = document.getElementById('btn-about-close');
const elAboutVersion  = document.getElementById('about-version');

const themeIconDark  = new URL('../src-tauri/svg/dark_mode.svg', import.meta.url).href;
const themeIconLight = new URL('../src-tauri/svg/light_mode.svg', import.meta.url).href;

// ── highlight.js theme injection ─────────────────────────────────────────

const hljsStyleEl = document.createElement('style');
document.head.appendChild(hljsStyleEl);

// ── Theme management ──────────────────────────────────────────────────────

const APP_NAME = 'EasyMarkdown';
const APP_VERSION = '1.0.0';
const APP_BUILD = 'Windows / Tauri / Vite';

function applyTheme() {
  elHtml.dataset.theme     = isDark ? 'dark' : 'light';
  hljsStyleEl.textContent  = isDark ? darkTheme : lightTheme;
  elImgTheme.src           = isDark ? themeIconLight : themeIconDark;
  elBtnTheme.title         = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
  isDark = !isDark;
  applyTheme();
  // Persist preference
  localStorage.setItem('easymd-theme', isDark ? 'dark' : 'light');
}

function printCurrentDocument() {
  if (activeIndex < 0) {
    showError('Open a document before printing.');
    return;
  }
  window.print();
  closeDrawer();
}

function openAbout() {
  elAboutVersion.textContent = APP_VERSION;
  closeDrawer();
  elAboutModal.classList.remove('hidden');
}

function closeAbout() {
  elAboutModal.classList.add('hidden');
}

function toggleDrawer() {
  elDrawerPanel.classList.toggle('hidden');
  elBtnMenu.setAttribute('aria-expanded', String(!elDrawerPanel.classList.contains('hidden')));
}

function closeDrawer() {
  elDrawerPanel.classList.add('hidden');
  elBtnMenu.setAttribute('aria-expanded', 'false');
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

const markdownImageBlobUrls = new Set();

function releaseMarkdownImageBlobUrls() {
  for (const blobUrl of markdownImageBlobUrls) {
    URL.revokeObjectURL(blobUrl);
  }
  markdownImageBlobUrls.clear();
}

// ── Utility ───────────────────────────────────────────────────────────────

/** Escape HTML entities so filenames/titles don't break the tab DOM. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isExternalSrc(src) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

function normalizeWindowsAbsolutePath(src) {
  if (typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (!trimmed) return null;

  // Drive-letter absolute paths like C:/foo/bar or C:\foo\bar.
  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    return trimmed.replace(/\\/g, '/');
  }

  // UNC paths like \\server\share\file.png.
  if (/^\\\\[^\\]+\\[^\\]+/i.test(trimmed)) {
    return trimmed.replace(/\\/g, '/');
  }

  return null;
}

function fileUrlToPath(fileUrl) {
  const decodedPath = decodeURIComponent(fileUrl.pathname);
  if (fileUrl.hostname) {
    return `//${fileUrl.hostname}${decodedPath}`;
  }
  if (/^\/[a-z]:/i.test(decodedPath)) {
    return decodedPath.slice(1);
  }
  return decodedPath;
}

function resolveMarkdownLocalPath(src, markdownPath) {
  if (typeof src !== 'string' || typeof markdownPath !== 'string') return null;

  const trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;

  const windowsAbsolute = normalizeWindowsAbsolutePath(trimmed);
  if (windowsAbsolute) return windowsAbsolute;

  if (isExternalSrc(trimmed)) return null;

  try {
    const baseFileUrl = new URL(`file:///${markdownPath.replace(/\\/g, '/')}`);
    const resolvedFileUrl = new URL(trimmed, baseFileUrl);
    if (resolvedFileUrl.protocol !== 'file:') return null;
    return fileUrlToPath(resolvedFileUrl);
  } catch {
    return null;
  }
}

function getImageMimeTypeFromPath(path) {
  if (typeof path !== 'string') return 'application/octet-stream';
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

async function hydrateMarkdownImages() {
  const images = Array.from(elMarkdownBody.querySelectorAll('img[data-easymd-local-path]'));
  for (const img of images) {
    const localPath = img.dataset.easymdLocalPath;
    if (!localPath) continue;

    try {
      const bytes = await readFile(localPath);
      const mime = getImageMimeTypeFromPath(localPath);
      const blob = new Blob([bytes], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      markdownImageBlobUrls.add(blobUrl);
      img.setAttribute('src', blobUrl);
    } catch {
      img.setAttribute('src', convertFileSrc(localPath));
    }
  }
}

function resolveMarkdownImageSrc(src, markdownPath) {
  if (typeof src !== 'string' || typeof markdownPath !== 'string') return src;

  const localPath = resolveMarkdownLocalPath(src, markdownPath);
  if (localPath) {
    return convertFileSrc(localPath);
  }

  const trimmed = src.trim();
  if (!trimmed) return src;

  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return src;

  if (isExternalSrc(trimmed)) return src;

  try {
    const baseFileUrl = new URL(`file:///${markdownPath.replace(/\\/g, '/')}`);
    const resolvedFileUrl = new URL(trimmed, baseFileUrl);
    if (resolvedFileUrl.protocol !== 'file:') return src;

    const localPath = fileUrlToPath(resolvedFileUrl);
    const assetUrl = convertFileSrc(localPath);
    return `${assetUrl}${resolvedFileUrl.search}${resolvedFileUrl.hash}`;
  } catch {
    return src;
  }
}

// ── Markdown parsing ──────────────────────────────────────────────────────

/**
 * Parse raw markdown text into highlighted HTML.
 * Pure function — no DOM side effects.
 * @param {string} content
 * @param {string} markdownPath
 * @returns {string}
 */
function parseMarkdown(content, markdownPath) {
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

  tmp.querySelectorAll('img[src]').forEach((img) => {
    const originalSrc = img.getAttribute('src');
    const localPath = resolveMarkdownLocalPath(originalSrc, markdownPath);
    const resolvedSrc = resolveMarkdownImageSrc(originalSrc, markdownPath);

    if (localPath) {
      img.dataset.easymdLocalPath = localPath;
      img.removeAttribute('src');
      return;
    }

    if (resolvedSrc) img.setAttribute('src', resolvedSrc);
  });

  return tmp.innerHTML;
}

// ── Tab persistence ──────────────────────────────────────────────────────

/** Save the current tab paths to disk (Rust command). */
async function persistTabs() {
  await invoke('save_tabs', { paths: tabs.map((t) => t.path) }).catch(() => {});
}

/** Re-open tabs that were saved from the previous session. */
async function restoreTabs() {
  let paths = [];
  try {
    paths = await invoke('load_tabs');
  } catch {
    return;
  }
  if (!Array.isArray(paths) || paths.length === 0) return;

  // Skip paths already opened (e.g. the initial file from argv[1]).
  const existing = new Set(tabs.map((t) => t.path));
  for (const p of paths) {
    if (typeof p === 'string' && p.trim() && !existing.has(p)) {
      await openFileAsTab(p).catch(() => {}); // silently skip missing files
    }
  }
}

// ── Tab management ────────────────────────────────────────────────────────

/** Rebuild the tab bar DOM from the `tabs` array. */
function renderTabs() {
  if (tabs.length === 0) {
    elTabs.innerHTML = '';
    elTabsBar.classList.add('hidden');
    return;
  }

  elTabsBar.classList.remove('hidden');

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

  releaseMarkdownImageBlobUrls();
  elMarkdownBody.innerHTML = tab.html;
  hydrateMarkdownImages().catch((err) => {
    showError(`Failed to load local images: ${err}`);
  });
  elMarkdownBody.classList.remove('hidden');
  elWelcome.classList.add('hidden');
  elBtnReload.classList.remove('hidden');

  elContent.scrollTop = 0;
  document.title = `${tab.filename} — EasyMarkdown`;

  renderTabs();
}

/** Close the tab at `index` and switch to the nearest sibling. */
async function closeTab(index) {
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    activeIndex = -1;
    showWelcome();
    await persistTabs();
    return;
  }
  // Move to the neighbour closer to the end of the old list.
  const next = Math.min(index, tabs.length - 1);
  switchTab(next);
  await persistTabs();
}

/** Show the welcome screen (no open files). */
function showWelcome() {
  releaseMarkdownImageBlobUrls();
  elMarkdownBody.classList.add('hidden');
  elWelcome.classList.remove('hidden');
  elBtnReload.classList.add('hidden');
  elFilePath.textContent = '';
  elFilePath.title = '';
  document.title = 'EasyMarkdown';
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
    const html = parseMarkdown(content, path);
    const filename = path.replace(/\\/g, '/').split('/').pop() ?? path;

    // Already open? Refresh content and switch to it.
    const existingIdx = tabs.findIndex((t) => t.path === path);
    if (existingIdx >= 0) {
      tabs[existingIdx] = { path, html, filename };
      switchTab(existingIdx);
      await persistTabs();
      return;
    }

    // New tab.
    tabs.push({ path, html, filename });
    switchTab(tabs.length - 1);
    await persistTabs();
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
elBtnPrint.addEventListener('click', printCurrentDocument);
elBtnAbout.addEventListener('click', openAbout);
elBtnTheme.addEventListener('click', toggleTheme);
elBtnMenu.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDrawer();
});
elBtnDismiss.addEventListener('click', hideError);

elMarkdownBody.addEventListener('click', async (event) => {
  const anchor = event.target.closest('a[href]');
  if (!anchor || !elMarkdownBody.contains(anchor)) return;

  const href = anchor.getAttribute('href')?.trim();
  if (!href) return;
  if (href.startsWith('#')) return;

  event.preventDefault();

  const currentPath = tabs[activeIndex]?.path;
  const localPath = currentPath ? resolveMarkdownLocalPath(href, currentPath) : null;

  try {
    if (localPath) {
      if (MD_EXTENSIONS.test(localPath)) {
        await openFileAsTab(localPath);
      } else {
        await openPath(localPath);
      }
      return;
    }

    if (isExternalSrc(href)) {
      await openUrl(href);
    }
  } catch (err) {
    showError(`Could not open link: ${err}`);
  }
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
});

document.addEventListener('click', () => {
  if (!elDrawerPanel.classList.contains('hidden')) closeDrawer();
});

elDrawerPanel.addEventListener('click', (event) => {
  event.stopPropagation();
});

// About dialog
elAboutClose.addEventListener('click', closeAbout);
elAboutModal.addEventListener('click', (e) => {
  if (e.target === elAboutModal) closeAbout();
});

// Tab click delegation — switch to tab on click, close on × click.
elTabs.addEventListener('click', async (e) => {
  const closeBtn = e.target.closest('.tab-close');
  if (closeBtn) {
    e.stopPropagation();
    const idx = parseInt(closeBtn.dataset.close, 10);
    if (!isNaN(idx)) await closeTab(idx);
    return;
  }
  const tabEl = e.target.closest('.tab');
  if (tabEl) {
    const idx = parseInt(tabEl.dataset.index, 10);
    if (!isNaN(idx)) switchTab(idx);
  }
});

// Keyboard shortcuts.
document.addEventListener('keydown', async (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'o') { e.preventDefault(); pickAndOpenFile(); return; }
  if (mod && e.key === 'r') { e.preventDefault(); reloadFile(); return; }
  if (mod && e.key === 'p') { e.preventDefault(); printCurrentDocument(); return; }
  if (mod && e.key === 'w') { e.preventDefault(); if (activeIndex >= 0) await closeTab(activeIndex); return; }
  if (e.key === 'Escape' && !elAboutModal.classList.contains('hidden')) {
    closeAbout();
    return;
  }
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

  // 4. Restore tabs from the previous session.
  //    openFileAsTab() deduplicates, so the initial file (step 3) won't
  //    appear twice. Missing files are silently skipped.
  await restoreTabs();

  // 5. Finaly open the tabs with the files
  if (typeof initialPath === 'string' && initialPath.trim()) {
    await openFileAsTab(initialPath);
  }

}

init().catch(console.error);
