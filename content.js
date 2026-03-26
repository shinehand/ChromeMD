/**
 * ChromeMD - Markdown Reader & Editor
 * Content script: intercepts .md file requests and renders them with view/edit/save support.
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
  let previewScrollTop = 0; // 보기 모드 스크롤 위치 복원용

  /** ──────────────────────────────
   *  Bootstrap
   * ────────────────────────────── */
  rawMarkdown = readRawContent();
  buildUI(rawMarkdown);

  // 미저장 변경 사항이 있을 때 페이지 이탈 경고
  window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = '저장되지 않은 변경 사항이 있습니다. 페이지를 벗어나시겠습니까?';
    }
  });

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
   *  Slugify (제목 앵커 ID 생성) — 한글 포함 유니코드 지원
   * ────────────────────────────── */
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/\s+/g, '-')         // 공백 → 하이픈
      .replace(/[<>"'&]/g, '')      // HTML 특수문자 제거
      .replace(/-+/g, '-')          // 중복 하이픈 정리
      .replace(/^-+|-+$/g, '')      // 앞뒤 하이픈 제거
      || 'heading';
  }

  /** ──────────────────────────────
   *  Configure marked + highlight.js
   * ────────────────────────────── */
  function configureMarked() {
    if (typeof marked === 'undefined') return;

    marked.use({ gfm: true, breaks: false, pedantic: false });

    const renderer = new marked.Renderer();

    // 코드 블록 — 구문 강조
    renderer.code = function (code, lang) {
      // marked v9+ passes a token object as first argument
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

    // 제목 — 앵커 링크 자동 생성
    renderer.heading = function (tokenOrText, levelArg) {
      const isToken = tokenOrText !== null && typeof tokenOrText === 'object';
      const text  = isToken ? tokenOrText.text  : tokenOrText;
      const level = isToken ? tokenOrText.depth : levelArg;
      const raw   = isToken ? (tokenOrText.raw || text) : (arguments[2] || text);
      const id    = slugify(raw.replace(/^#{1,6}\s+/, '').replace(/\s+$/, ''));
      return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-hidden="true">¶</a>${text}</h${level}>\n`;
    };

    marked.use({ renderer });
  }

  /** ──────────────────────────────
   *  HTML 새니타이저 (XSS 방지)
   * ────────────────────────────── */
  function sanitizeHtml(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      // script 태그 제거
      doc.querySelectorAll('script').forEach((el) => el.remove());
      // 위험한 속성 제거
      doc.querySelectorAll('*').forEach((el) => {
        const toRemove = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const { name, value } = el.attributes[i];
          const v = value.trim().replace(/\s+/g, '').toLowerCase();
          const isDangerousScheme =
            v.startsWith('javascript:') ||
            v.startsWith('vbscript:') ||
            v.startsWith('data:');
          if (
            name.toLowerCase().startsWith('on') ||
            (isDangerousScheme && ['href', 'src', 'action', 'formaction'].includes(name.toLowerCase()))
          ) {
            toRemove.push(name);
          }
        }
        toRemove.forEach((n) => el.removeAttribute(n));
      });
      return doc.body.innerHTML;
    } catch (e) {
      return escapeHtml(html);
    }
  }

  /** ──────────────────────────────
   *  Render markdown → HTML
   * ────────────────────────────── */
  function renderMarkdown(md) {
    if (typeof marked === 'undefined') {
      return '<pre>' + escapeHtml(md) + '</pre>';
    }
    try {
      return sanitizeHtml(marked.parse(md));
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
   *  상태 표시줄 업데이트
   * ────────────────────────────── */
  function updateStatusBar() {
    const wcEl     = document.getElementById('chromemd-status-wc');
    const cursorEl = document.getElementById('chromemd-status-cursor');
    if (!wcEl) return;

    const words = rawMarkdown.trim() === '' ? 0 : rawMarkdown.trim().split(/\s+/).length;
    const chars = rawMarkdown.length;
    const lines = rawMarkdown.split('\n').length;
    wcEl.textContent = `${lines}줄 · ${words}단어 · ${chars}글자`;

    if (cursorEl) {
      if (currentMode !== 'view') {
        const textarea = document.getElementById('chromemd-textarea');
        if (textarea) {
          const before  = textarea.value.substring(0, textarea.selectionStart);
          const bLines  = before.split('\n');
          cursorEl.textContent = `줄 ${bLines.length}, 열 ${bLines[bLines.length - 1].length + 1}`;
        }
      } else {
        cursorEl.textContent = '';
      }
    }
  }

  /** ──────────────────────────────
   *  Build the full UI
   * ────────────────────────────── */
  function buildUI(md) {
    configureMarked();

    // 기존 페이지 내용 제거
    document.documentElement.innerHTML = '';

    // html/head/body 재구성
    document.documentElement.lang = 'ko';
    const head = document.createElement('head');
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.appendChild(meta);
    const metaViewport = document.createElement('meta');
    metaViewport.setAttribute('name', 'viewport');
    metaViewport.setAttribute('content', 'width=device-width, initial-scale=1');
    head.appendChild(metaViewport);
    const title = document.createElement('title');
    title.textContent = getFilename() + ' — ChromeMD';
    head.appendChild(title);
    document.documentElement.appendChild(head);

    const body = document.createElement('body');
    body.id = 'chromemd-root';
    document.documentElement.appendChild(body);

    // ── 툴바 ──────────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.id = 'chromemd-toolbar';
    toolbar.innerHTML = `
      <div class="chromemd-toolbar-left">
        <span class="chromemd-icon">📄</span>
        <span class="chromemd-filename" title="${escapeHtml(url)}">${escapeHtml(getFilename())}</span>
        <span class="chromemd-dirty" id="chromemd-dirty" style="display:none" title="저장되지 않은 변경 사항">●</span>
      </div>
      <div class="chromemd-toolbar-center">
        <button id="btn-view"  class="chromemd-btn chromemd-btn-active" title="보기 모드 (Ctrl+E)">보기</button>
        <button id="btn-split" class="chromemd-btn" title="분할 모드">분할</button>
        <button id="btn-edit"  class="chromemd-btn" title="편집 모드 (Ctrl+E)">편집</button>
      </div>
      <div class="chromemd-toolbar-right">
        <button id="btn-save" class="chromemd-btn chromemd-btn-save" title="파일 저장 (Ctrl+S)">💾 저장</button>
      </div>
    `;
    body.appendChild(toolbar);

    // ── 메인 콘텐츠 영역 ────────────────────────────────
    const main = document.createElement('div');
    main.id = 'chromemd-main';
    body.appendChild(main);

    // 미리보기 패널
    const preview = document.createElement('div');
    preview.id = 'chromemd-preview';
    const article = document.createElement('article');
    article.id = 'chromemd-article';
    article.className = 'markdown-body';
    article.innerHTML = renderMarkdown(md);
    preview.appendChild(article);
    main.appendChild(preview);

    // 편집기 패널
    const editor = document.createElement('div');
    editor.id = 'chromemd-editor';
    editor.style.display = 'none';
    const textarea = document.createElement('textarea');
    textarea.id = 'chromemd-textarea';
    textarea.spellcheck = false;
    textarea.value = md;
    editor.appendChild(textarea);
    main.appendChild(editor);

    // ── 상태 표시줄 ─────────────────────────────────────
    const statusBar = document.createElement('div');
    statusBar.id = 'chromemd-status';
    statusBar.innerHTML = `
      <span id="chromemd-status-cursor"></span>
      <span id="chromemd-status-wc"></span>
    `;
    body.appendChild(statusBar);

    // ── 이벤트 연결 ─────────────────────────────────────
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
      updateStatusBar();
    });

    // Tab 키 → 공백 2칸 삽입
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;
        textarea.value =
          textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        rawMarkdown = textarea.value;
        markDirty(true);
        if (currentMode === 'split') {
          article.innerHTML = renderMarkdown(rawMarkdown);
        }
        updateStatusBar();
      }
    });

    // 커서 위치 추적 (상태 표시줄 업데이트)
    textarea.addEventListener('keyup',   updateStatusBar);
    textarea.addEventListener('mouseup', updateStatusBar);

    // 전역 단축키
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

    updateStatusBar();
  }

  /** ──────────────────────────────
   *  모드 전환
   * ────────────────────────────── */
  function setMode(mode) {
    const preview  = document.getElementById('chromemd-preview');
    const editor   = document.getElementById('chromemd-editor');
    const article  = document.getElementById('chromemd-article');
    const main     = document.getElementById('chromemd-main');
    const textarea = document.getElementById('chromemd-textarea');

    // 보기 모드에서 이탈 전 스크롤 위치 저장
    if (currentMode === 'view' && preview) {
      previewScrollTop = preview.scrollTop;
    }

    currentMode = mode;

    document.getElementById('btn-view').classList.toggle('chromemd-btn-active', mode === 'view');
    document.getElementById('btn-split').classList.toggle('chromemd-btn-active', mode === 'split');
    document.getElementById('btn-edit').classList.toggle('chromemd-btn-active', mode === 'edit');

    if (mode === 'view') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      preview.style.display = '';
      editor.style.display  = 'none';
      main.classList.remove('chromemd-split');
      // 스크롤 위치 복원
      requestAnimationFrame(() => { preview.scrollTop = previewScrollTop; });
    } else if (mode === 'edit') {
      preview.style.display = 'none';
      editor.style.display  = '';
      main.classList.remove('chromemd-split');
      textarea.focus();
    } else if (mode === 'split') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      preview.style.display = '';
      editor.style.display  = '';
      main.classList.add('chromemd-split');
      textarea.focus();
    }

    updateStatusBar();
  }

  /** ──────────────────────────────
   *  미저장 상태 표시
   * ────────────────────────────── */
  function markDirty(dirty) {
    isDirty = dirty;
    const indicator = document.getElementById('chromemd-dirty');
    if (indicator) indicator.style.display = dirty ? '' : 'none';
  }

  /** ──────────────────────────────
   *  저장 / 다운로드
   * ────────────────────────────── */
  function saveFile() {
    const filename  = getFilename();
    const blob      = new Blob([rawMarkdown], { type: 'text/markdown;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href     = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);

    markDirty(false);
    showToast('💾 저장됨: ' + filename);
  }

  /** ──────────────────────────────
   *  토스트 알림
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
