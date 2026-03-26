/**
 * ChromeMD - Markdown Reader & Editor
 * Content script: intercepts .md file requests and renders them with view/edit support.
 */

(function () {
  'use strict';

  // Only run if the current URL is a Markdown file
  const url = window.location.href;
  if (!isMdUrl(url)) return;

  // Avoid double-initialization
  if (document.getElementById('chromemd-root')) return;

  /** ──────────────────────────────
   *  State
   * ────────────────────────────── */
  let rawMarkdown = '';
  let currentMode = 'view'; // 'view' | 'edit' | 'split'
  let isDirty = false;

  /** ──────────────────────────────
   *  Bootstrap
   * ────────────────────────────── */
  rawMarkdown = readRawContent();
  buildUI(rawMarkdown);

  /** ──────────────────────────────
   *  URL helpers
   * ────────────────────────────── */
  function isMdUrl(href) {
    try {
      const pathname = new URL(href).pathname;
      return /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|text)$/i.test(pathname);
    } catch (e) {
      return /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|text)(\?|#|$)/i.test(href);
    }
  }

  function getFilename() {
    try {
      const parts = new URL(url).pathname.split('/');
      return decodeURIComponent(parts[parts.length - 1]) || 'document.md';
    } catch (e) {
      return 'document.md';
    }
  }

  /** ──────────────────────────────
   *  Read raw markdown from the page
   * ────────────────────────────── */
  function readRawContent() {
    // Chrome renders plain text files inside <pre> wrapped in <body>
    const pre = document.querySelector('pre');
    if (pre) return pre.textContent || '';

    // Fall back to body text
    return document.body ? (document.body.innerText || document.body.textContent || '') : '';
  }

  /** ──────────────────────────────
   *  Configure marked + highlight.js
   * ────────────────────────────── */
  function configureMarked() {
    if (typeof marked === 'undefined') return;

    // Use marked v9+ API
    marked.use({
      breaks: false,
      gfm: true,
      pedantic: false,
      highlight: null,
    });

    // Custom renderer for highlighted code blocks
    const renderer = new marked.Renderer();
    renderer.code = function (code, lang) {
      // marked v9 passes an object for the first parameter
      const codeStr = typeof code === 'object' ? code.text : code;
      const langStr = typeof code === 'object' ? code.lang : lang;

      if (typeof hljs !== 'undefined' && langStr) {
        const validLang = hljs.getLanguage(langStr) ? langStr : 'plaintext';
        try {
          const highlighted = hljs.highlight(codeStr, { language: validLang }).value;
          return `<pre><code class="hljs language-${validLang}">${highlighted}</code></pre>`;
        } catch (_) {
          // fall through
        }
      }
      if (typeof hljs !== 'undefined') {
        const highlighted = hljs.highlightAuto(codeStr).value;
        return `<pre><code class="hljs">${highlighted}</code></pre>`;
      }
      const escaped = codeStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${escaped}</code></pre>`;
    };

    marked.use({ renderer });
  }

  /** ──────────────────────────────
   *  Render markdown → HTML
   * ────────────────────────────── */
  function renderMarkdown(md) {
    if (typeof marked === 'undefined') {
      // Fallback: plain text
      return '<pre>' + escapeHtml(md) + '</pre>';
    }
    try {
      return marked.parse(md);
    } catch (e) {
      return '<pre>' + escapeHtml(md) + '</pre>';
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** ──────────────────────────────
   *  Build the full UI
   * ────────────────────────────── */
  function buildUI(md) {
    configureMarked();

    // Remove original page content
    document.documentElement.innerHTML = '';

    // Rebuild html/head/body cleanly
    document.documentElement.lang = 'en';
    const head = document.createElement('head');
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.appendChild(meta);
    const title = document.createElement('title');
    title.textContent = getFilename() + ' — ChromeMD';
    head.appendChild(title);
    document.documentElement.appendChild(head);

    const body = document.createElement('body');
    body.id = 'chromemd-root';
    document.documentElement.appendChild(body);

    // ── Toolbar ──────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.id = 'chromemd-toolbar';
    toolbar.innerHTML = `
      <div class="chromemd-toolbar-left">
        <span class="chromemd-icon">📄</span>
        <span class="chromemd-filename" title="${escapeHtml(url)}">${escapeHtml(getFilename())}</span>
        <span class="chromemd-dirty" id="chromemd-dirty" style="display:none">●</span>
      </div>
      <div class="chromemd-toolbar-center">
        <button id="btn-view"   class="chromemd-btn chromemd-btn-active" title="View mode">View</button>
        <button id="btn-split"  class="chromemd-btn" title="Split mode">Split</button>
        <button id="btn-edit"   class="chromemd-btn" title="Edit mode">Edit</button>
      </div>
      <div class="chromemd-toolbar-right">
        <button id="btn-save"   class="chromemd-btn chromemd-btn-save" title="Download the (modified) Markdown file">💾 Save</button>
      </div>
    `;
    body.appendChild(toolbar);

    // ── Main content area ─────────────────────────────
    const main = document.createElement('div');
    main.id = 'chromemd-main';
    body.appendChild(main);

    // Preview pane
    const preview = document.createElement('div');
    preview.id = 'chromemd-preview';
    const article = document.createElement('article');
    article.id = 'chromemd-article';
    article.className = 'markdown-body';
    article.innerHTML = renderMarkdown(md);
    preview.appendChild(article);
    main.appendChild(preview);

    // Editor pane
    const editor = document.createElement('div');
    editor.id = 'chromemd-editor';
    editor.style.display = 'none';
    const textarea = document.createElement('textarea');
    textarea.id = 'chromemd-textarea';
    textarea.spellcheck = false;
    textarea.value = md;
    editor.appendChild(textarea);
    main.appendChild(editor);

    // ── Event wiring ──────────────────────────────────
    document.getElementById('btn-view').addEventListener('click', () => setMode('view'));
    document.getElementById('btn-split').addEventListener('click', () => setMode('split'));
    document.getElementById('btn-edit').addEventListener('click', () => setMode('edit'));
    document.getElementById('btn-save').addEventListener('click', saveFile);

    textarea.addEventListener('input', () => {
      rawMarkdown = textarea.value;
      markDirty(true);
      if (currentMode === 'split') {
        article.innerHTML = renderMarkdown(rawMarkdown);
      }
    });

    // Handle Tab key in textarea (insert 2 spaces instead of focus change)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + '  ' + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        rawMarkdown = textarea.value;
        markDirty(true);
        if (currentMode === 'split') {
          article.innerHTML = renderMarkdown(rawMarkdown);
        }
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        setMode(currentMode === 'view' ? 'edit' : 'view');
      }
    });
  }

  /** ──────────────────────────────
   *  Switch view mode
   * ────────────────────────────── */
  function setMode(mode) {
    currentMode = mode;
    const preview = document.getElementById('chromemd-preview');
    const editor = document.getElementById('chromemd-editor');
    const article = document.getElementById('chromemd-article');
    const main = document.getElementById('chromemd-main');

    document.getElementById('btn-view').classList.toggle('chromemd-btn-active', mode === 'view');
    document.getElementById('btn-split').classList.toggle('chromemd-btn-active', mode === 'split');
    document.getElementById('btn-edit').classList.toggle('chromemd-btn-active', mode === 'edit');

    if (mode === 'view') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      preview.style.display = '';
      editor.style.display = 'none';
      main.classList.remove('chromemd-split');
    } else if (mode === 'edit') {
      preview.style.display = 'none';
      editor.style.display = '';
      main.classList.remove('chromemd-split');
      document.getElementById('chromemd-textarea').focus();
    } else if (mode === 'split') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      preview.style.display = '';
      editor.style.display = '';
      main.classList.add('chromemd-split');
      document.getElementById('chromemd-textarea').focus();
    }
  }

  /** ──────────────────────────────
   *  Dirty state
   * ────────────────────────────── */
  function markDirty(dirty) {
    isDirty = dirty;
    const indicator = document.getElementById('chromemd-dirty');
    if (indicator) indicator.style.display = dirty ? '' : 'none';
  }

  /** ──────────────────────────────
   *  Save / Download
   * ────────────────────────────── */
  function saveFile() {
    const content = rawMarkdown;
    const filename = getFilename();
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke after a short delay
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);

    markDirty(false);
    showToast('💾 Saved: ' + filename);
  }

  /** ──────────────────────────────
   *  Toast notification
   * ────────────────────────────── */
  function showToast(message) {
    let toast = document.getElementById('chromemd-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'chromemd-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('chromemd-toast-show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('chromemd-toast-show'), 2500);
  }
})();
