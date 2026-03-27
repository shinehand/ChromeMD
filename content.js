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
  let sidebarMode = null;   // null | 'toc' | 'files'
  let tocObserver = null;   // IntersectionObserver for TOC active-heading tracking
  let syncingScroll = false; // 분할 모드 스크롤 동기화 플래그
  const copyTimers = new WeakMap(); // timers for copy-button feedback reset

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
    const readMins = Math.max(1, Math.ceil(words / 200));
    wcEl.textContent = `${lines}줄 · ${words}단어 · ${chars}글자 · 약 ${readMins}분`;

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
        <button id="btn-sidebar-files" class="chromemd-btn chromemd-btn-icon" title="파일 탐색기"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg></button>
        <button id="btn-sidebar-toc" class="chromemd-btn chromemd-btn-icon" title="목차"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M0 2.75A.75.75 0 01.75 2h14.5a.75.75 0 010 1.5H.75A.75.75 0 010 2.75zm0 5A.75.75 0 01.75 7h14.5a.75.75 0 010 1.5H.75A.75.75 0 010 7.75zm0 5a.75.75 0 01.75-.75H8.25a.75.75 0 010 1.5H.75a.75.75 0 01-.75-.75z"/></svg></button>
        <span class="chromemd-toolbar-sep"></span>
        <span class="chromemd-icon">📄</span>
        <span class="chromemd-filename" title="${escapeHtml(url)}">${escapeHtml(getFilename())}</span>
        <span class="chromemd-dirty" id="chromemd-dirty" style="display:none" title="저장되지 않은 변경 사항">●</span>
      </div>
      <div class="chromemd-toolbar-center">
        <div class="chromemd-mode-switcher" role="group" aria-label="보기 모드">
          <button id="btn-view"  class="chromemd-btn chromemd-btn-active" title="보기 모드 (Ctrl+E)">보기</button>
          <button id="btn-split" class="chromemd-btn" title="분할 모드">분할</button>
          <button id="btn-edit"  class="chromemd-btn" title="편집 모드 (Ctrl+E)">편집</button>
        </div>
      </div>
      <div class="chromemd-toolbar-right">
        <button id="btn-print" class="chromemd-btn chromemd-btn-icon" title="인쇄 (Ctrl+P)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1a2 2 0 00-2 2v1h10V3a2 2 0 00-2-2H5zm6 8H5a1 1 0 00-1 1v3h8v-3a1 1 0 00-1-1z"/><path d="M0 7a2 2 0 012-2h12a2 2 0 012 2v3a2 2 0 01-2 2h-1v-2a2 2 0 00-2-2H5a2 2 0 00-2 2v2H2a2 2 0 01-2-2V7zm2.5 1a.5.5 0 100-1 .5.5 0 000 1z"/></svg></button>
        <button id="btn-save" class="chromemd-btn chromemd-btn-save" title="파일 저장 (Ctrl+S)">💾 저장</button>
      </div>
    `;
    body.appendChild(toolbar);

    // ── 읽기 진행 표시줄 ─────────────────────────────────────────
    const progressBar = document.createElement('div');
    progressBar.id = 'chromemd-progress';
    progressBar.classList.add('chromemd-progress-visible');
    body.appendChild(progressBar);

    // ── 메인 콘텐츠 영역 ────────────────────────────────
    const main = document.createElement('div');
    main.id = 'chromemd-main';
    body.appendChild(main);

    // ── 사이드바 ─────────────────────────────────────────────────
    const sidebar = document.createElement('div');
    sidebar.id = 'chromemd-sidebar';
    const sidebarHeader = document.createElement('div');
    sidebarHeader.id = 'chromemd-sidebar-header';
    sidebar.appendChild(sidebarHeader);
    const sidebarContent = document.createElement('div');
    sidebarContent.id = 'chromemd-sidebar-content';
    sidebar.appendChild(sidebarContent);
    main.appendChild(sidebar);

    // 미리보기 패널
    const preview = document.createElement('div');
    preview.id = 'chromemd-preview';
    const article = document.createElement('article');
    article.id = 'chromemd-article';
    article.className = 'markdown-body';
    article.innerHTML = renderMarkdown(md);
    addCopyButtons(article);
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

    // 읽기 진행 표시줄 스크롤 업데이트 + 분할 모드 스크롤 동기화
    preview.addEventListener('scroll', () => {
      const bar = document.getElementById('chromemd-progress');
      if (bar) {
        const scrollable = preview.scrollHeight - preview.clientHeight;
        bar.style.width = (scrollable > 0 ? preview.scrollTop / scrollable * 100 : 100) + '%';
      }
      if (currentMode === 'split' && !syncingScroll) {
        syncingScroll = true;
        const scrollable = preview.scrollHeight - preview.clientHeight;
        if (scrollable > 0) {
          const ratio = preview.scrollTop / scrollable;
          const ta = document.getElementById('chromemd-textarea');
          if (ta) ta.scrollTop = ratio * Math.max(0, ta.scrollHeight - ta.clientHeight);
        }
        requestAnimationFrame(() => { syncingScroll = false; });
      }
    });

    // 분할 모드: 편집기 스크롤 → 미리보기 동기화
    textarea.addEventListener('scroll', () => {
      if (currentMode === 'split' && !syncingScroll) {
        syncingScroll = true;
        const scrollable = textarea.scrollHeight - textarea.clientHeight;
        if (scrollable > 0) {
          const ratio = textarea.scrollTop / scrollable;
          const pv = document.getElementById('chromemd-preview');
          if (pv) pv.scrollTop = ratio * Math.max(0, pv.scrollHeight - pv.clientHeight);
        }
        requestAnimationFrame(() => { syncingScroll = false; });
      }
    });

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
    document.getElementById('btn-sidebar-files').addEventListener('click', () => toggleSidebar('files'));
    document.getElementById('btn-sidebar-toc').addEventListener('click', () => toggleSidebar('toc'));
    document.getElementById('btn-print').addEventListener('click', () => window.print());

    textarea.addEventListener('input', () => {
      rawMarkdown = textarea.value;
      markDirty(true);
      if (currentMode === 'split') {
        article.innerHTML = renderMarkdown(rawMarkdown);
        addCopyButtons(article);
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
          addCopyButtons(article);
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

    // 목차를 기본으로 열기
    toggleSidebar('toc');
  }

  /** ──────────────────────────────
   *  사이드바 토글
   * ────────────────────────────── */
  function toggleSidebar(mode) {
    const sidebar  = document.getElementById('chromemd-sidebar');
    const btnFiles = document.getElementById('btn-sidebar-files');
    const btnToc   = document.getElementById('btn-sidebar-toc');
    if (sidebarMode === mode) {
      sidebarMode = null;
      sidebar.classList.remove('chromemd-sidebar-open');
      btnFiles.classList.remove('chromemd-btn-active');
      btnToc.classList.remove('chromemd-btn-active');
    } else {
      sidebarMode = mode;
      sidebar.classList.add('chromemd-sidebar-open');
      btnFiles.classList.toggle('chromemd-btn-active', mode === 'files');
      btnToc.classList.toggle('chromemd-btn-active', mode === 'toc');
      const hdr = document.getElementById('chromemd-sidebar-header');
      if (hdr) hdr.textContent = mode === 'toc' ? '목차' : '파일';
      if (mode === 'toc') buildTOC();
      else buildFileExplorer();
    }
  }

  /** ──────────────────────────────
   *  목차 (TOC) 생성
   * ────────────────────────────── */
  function buildTOC() {
    const content = document.getElementById('chromemd-sidebar-content');
    if (!content) return;

    const headings = [];
    let inCode = false;
    rawMarkdown.split('\n').forEach(line => {
      if (line.startsWith('```')) { inCode = !inCode; return; }
      if (inCode) return;
      const m = line.match(/^(#{1,6})\s+(.+)/);
      if (m) {
        const level      = m[1].length;
        const rawText    = m[2].trim();
        const displayText = rawText
          .replace(/\*\*(.*?)\*\*/g, '$1')
          .replace(/\*(.*?)\*/g, '$1')
          .replace(/`(.*?)`/g, '$1')
          .replace(/\[(.*?)\]\(.*?\)/g, '$1');
        headings.push({ level, displayText, id: slugify(rawText) });
      }
    });

    if (headings.length === 0) {
      content.innerHTML = '<p class="chromemd-sidebar-empty">목차가 없습니다.</p>';
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'chromemd-toc-list';
    headings.forEach(({ level, displayText, id }) => {
      const li = document.createElement('li');
      li.className = `chromemd-toc-item chromemd-toc-h${level}`;
      const a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = displayText;
      a.addEventListener('click', e => {
        e.preventDefault();
        if (currentMode === 'edit') setMode('view');
        const preview = document.getElementById('chromemd-preview');
        const target  = document.getElementById(id);
        if (preview && target) {
          const rect    = target.getBoundingClientRect();
          const pRect   = preview.getBoundingClientRect();
          preview.scrollBy({ top: rect.top - pRect.top - 16, behavior: 'smooth' });
        }
      });
      li.appendChild(a);
      ul.appendChild(li);
    });

    content.innerHTML = '';
    content.appendChild(ul);
    setupTocObserver();
  }

  /** ──────────────────────────────
   *  목차 활성 항목 추적 (IntersectionObserver)
   * ────────────────────────────── */
  function setupTocObserver() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    const article = document.getElementById('chromemd-article');
    const preview = document.getElementById('chromemd-preview');
    if (!article || !preview) return;
    const headings = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) return;

    tocObserver = new IntersectionObserver((entries) => {
      let topEntry = null;
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
            topEntry = entry;
          }
        }
      });
      if (topEntry) updateTocActiveItem(topEntry.target.id);
    }, { root: preview, rootMargin: '0px 0px -60% 0px', threshold: 0 });

    headings.forEach(h => { if (h.id) tocObserver.observe(h); });
  }

  function updateTocActiveItem(id) {
    const content = document.getElementById('chromemd-sidebar-content');
    if (!content) return;
    content.querySelectorAll('.chromemd-toc-item a').forEach(a => {
      a.classList.toggle('chromemd-toc-active', a.getAttribute('href') === '#' + id);
    });
  }

  /** ──────────────────────────────
   *  파일 탐색기 빌드
   * ────────────────────────────── */
  async function buildFileExplorer() {
    const content = document.getElementById('chromemd-sidebar-content');
    const hdr     = document.getElementById('chromemd-sidebar-header');
    if (!content) return;

    if (!url.startsWith('file://')) {
      content.innerHTML = '<p class="chromemd-sidebar-empty">파일 탐색기는 로컬 파일에서만 사용 가능합니다.</p>';
      return;
    }

    content.innerHTML = '<p class="chromemd-sidebar-loading">불러오는 중…</p>';
    const parentUrl = url.substring(0, url.lastIndexOf('/') + 1);

    if (hdr) {
      const parts = decodeURIComponent(parentUrl).replace(/\/$/, '').split('/');
      hdr.textContent = parts[parts.length - 1] || '파일';
    }

    await loadAndRenderDir(content, parentUrl, url);
  }

  async function loadAndRenderDir(container, dirUrl, currentFileUrl) {
    try {
      const html = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', dirUrl, true);
        xhr.onload = () => {
          // file:// URL responses use status 0; treat 0 and 200 as success
          if (xhr.status === 0 || xhr.status === 200) {
            resolve(xhr.responseText || '');
          } else {
            reject(new Error('HTTP ' + xhr.status));
          }
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send();
      });
      if (!html) throw new Error('empty response');
      const parser = new DOMParser();
      const doc    = parser.parseFromString(html, 'text/html');
      const entries = [];

      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (!href || href === '../' || href.startsWith('..') ||
            href.startsWith('?') || href.startsWith('#')) continue;
        // Skip non-file hrefs (e.g. full http URLs, chrome-internal links)
        if (href.startsWith('http://') || href.startsWith('https://') ||
            href.startsWith('chrome://')) continue;
        const isDir = href.endsWith('/');
        const name  = decodeURIComponent(href.replace(/\/$/, '').split('/').pop());
        if (!name || name.startsWith('.')) continue;
        entries.push({ name, href: new URL(href, dirUrl).href, isDir });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      renderFileEntries(container, entries, currentFileUrl);
    } catch (_) {
      container.innerHTML = '<p class="chromemd-sidebar-empty">폴더를 불러올 수 없습니다.</p>';
    }
  }

  function renderFileEntries(container, entries, currentFileUrl) {
    if (entries.length === 0) {
      container.innerHTML = '<p class="chromemd-sidebar-empty">파일이 없습니다.</p>';
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'chromemd-file-list';

    entries.forEach(entry => {
      const li        = document.createElement('li');
      const isCurrent = entry.href === currentFileUrl;
      const isMd      = !entry.isDir &&
        /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|text)$/i.test(entry.name);
      li.className = 'chromemd-file-item';

      if (entry.isDir) {
        const row    = document.createElement('div');
        row.className = 'chromemd-file-row';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const toggle = document.createElement('span');
        toggle.className = 'chromemd-file-toggle';
        toggle.textContent = '▶';

        const icon = document.createElement('span');
        icon.className = 'chromemd-file-icon';
        icon.textContent = '📁';

        const nameEl = document.createElement('span');
        nameEl.className = 'chromemd-file-name';
        nameEl.textContent = entry.name;

        row.appendChild(toggle);
        row.appendChild(icon);
        row.appendChild(nameEl);
        li.appendChild(row);

        const sub = document.createElement('div');
        sub.className = 'chromemd-file-subtree';
        li.appendChild(sub);

        let open = false;
        const expandDir = async () => {
          open = !open;
          toggle.textContent = open ? '▼' : '▶';
          sub.style.display = open ? '' : 'none';
          if (open && !sub.dataset.loaded) {
            sub.dataset.loaded = '1';
            sub.innerHTML = '<p class="chromemd-sidebar-loading">불러오는 중…</p>';
            await loadAndRenderDir(sub, entry.href, currentFileUrl);
          }
        };
        row.addEventListener('click', expandDir);
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandDir(); }
        });

      } else {
        const a = document.createElement('a');
        a.className = 'chromemd-file-row' + (isCurrent ? ' chromemd-file-row-current' : '');
        a.href = entry.href;

        const icon = document.createElement('span');
        icon.className = 'chromemd-file-icon' + (isMd ? ' chromemd-file-icon-md' : '');
        icon.textContent = isMd ? 'M' : '📄';

        const nameEl = document.createElement('span');
        nameEl.className = 'chromemd-file-name';
        nameEl.textContent = entry.name;

        a.appendChild(icon);
        a.appendChild(nameEl);
        li.appendChild(a);

        if (!isCurrent) {
          a.addEventListener('click', e => {
            e.preventDefault();
            window.location.href = entry.href;
          });
        }
      }

      ul.appendChild(li);
    });

    container.innerHTML = '';
    container.appendChild(ul);
  }

  /** ──────────────────────────────
   *  코드 블록 복사 버튼
   * ────────────────────────────── */
  function addCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.parentNode && pre.parentNode.classList.contains('chromemd-code-wrapper')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'chromemd-code-wrapper';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const btn = document.createElement('button');
      btn.className = 'chromemd-copy-btn';
      btn.textContent = '복사';
      btn.title = '코드 복사';
      btn.setAttribute('aria-label', '코드를 클립보드에 복사');
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        const onCopied = () => {
          btn.textContent = '✓ 복사됨';
          btn.classList.add('chromemd-copy-success');
          clearTimeout(copyTimers.get(btn));
          copyTimers.set(btn, setTimeout(() => {
            btn.textContent = '복사';
            btn.classList.remove('chromemd-copy-success');
          }, 2000));
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onCopied).catch(() => { legacyCopy(text); onCopied(); });
        } else {
          legacyCopy(text); onCopied();
        }
      });
      wrapper.appendChild(btn);
    });
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (err) { console.warn('[ChromeMD] 복사 실패:', err); }
    document.body.removeChild(ta);
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

    // 미리 보기가 표시된 모드에서 이탈 전 스크롤 위치 저장
    if ((currentMode === 'view' || currentMode === 'split') && preview) {
      previewScrollTop = preview.scrollTop;
    }

    currentMode = mode;

    document.getElementById('btn-view').classList.toggle('chromemd-btn-active', mode === 'view');
    document.getElementById('btn-split').classList.toggle('chromemd-btn-active', mode === 'split');
    document.getElementById('btn-edit').classList.toggle('chromemd-btn-active', mode === 'edit');

    if (mode === 'view') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      addCopyButtons(article);
      preview.style.display = '';
      editor.style.display  = 'none';
      main.classList.remove('chromemd-split');
      document.getElementById('chromemd-progress')?.classList.add('chromemd-progress-visible');
      // DOM 재렌더링 후 레이아웃이 확정된 다음 프레임에 스크롤 복원
      requestAnimationFrame(() => { preview.scrollTop = previewScrollTop; });
    } else if (mode === 'edit') {
      preview.style.display = 'none';
      editor.style.display  = '';
      main.classList.remove('chromemd-split');
      document.getElementById('chromemd-progress')?.classList.remove('chromemd-progress-visible');
      textarea.focus();
    } else if (mode === 'split') {
      article.innerHTML = renderMarkdown(rawMarkdown);
      addCopyButtons(article);
      preview.style.display = '';
      editor.style.display  = '';
      main.classList.add('chromemd-split');
      document.getElementById('chromemd-progress')?.classList.add('chromemd-progress-visible');
      // DOM 재렌더링 후 레이아웃이 확정된 다음 프레임에 스크롤 복원
      requestAnimationFrame(() => { preview.scrollTop = previewScrollTop; });
      textarea.focus();
    }

    if (sidebarMode === 'toc') buildTOC();
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
