// Drive the real Gemini composer and DOM; never call private chat APIs.
(() => {
  if (location.hostname !== 'gemini.google.com' || window.top !== window || window.__qchat) return;
  const selectors = {
    composer: [
      'rich-textarea [contenteditable="true"]',
      '.ql-editor[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label*="prompt" i]',
      '[contenteditable="true"][role="textbox"]'
    ],
    send: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      '.send-button-container button'
    ],
    stop: [
      'button[aria-label*="Stop" i]',
      'button[aria-label="Stop response"]'
    ],
    assistant: ['model-response'],
    user: ['user-query'],
    body: ['message-content .markdown', '.markdown-main-panel', 'message-content', '.markdown'],
    fresh: [
      'gem-nav-list-item[data-test-id="reset-button"] a',
      '[data-test-id="reset-button"] a',
      '[data-test-id="reset-button"]',
      'a[aria-label="New chat"][href="/app"]',
      'a[aria-label="New chat"]'
    ]
  };
  const shown = node => !!(node && node.isConnected !== false && node.getClientRects?.().length && !node.closest?.('[hidden], [aria-hidden="true"]'));
  const find = key => {
    if (key === 'composer') {
      return selectors.composer.flatMap(s => [...document.querySelectorAll(s)]).find(node =>
        shown(node) && !node.classList?.contains('ql-clipboard'));
    }
    if (key === 'stop') {
      return [...document.querySelectorAll('button')].find(node =>
        shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
        /stop/i.test(node.getAttribute('aria-label') || ''));
    }
    if (key === 'send') {
      return selectors.send.flatMap(s => [...document.querySelectorAll(s)]).find(node =>
        shown(node) && !/stop/i.test(node.getAttribute('aria-label') || ''));
    }
    return selectors[key].flatMap(s => [...document.querySelectorAll(s)]).find(shown);
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const queue = [];
  function wellFormed(text) {
    return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, part => part.length === 2 ? part : '\uFFFD');
  }
  function transportValue(value) {
    if (typeof value === 'string') return wellFormed(value);
    if (Array.isArray(value)) return value.map(transportValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transportValue(item)]));
    return value;
  }
  function deliveryFailed(event) {
    if (event.type === 'delta' && active?.id === event.id && !active.finished) active.sentText = null;
  }
  function flush() {
    if (typeof window.__QCHAT_EMIT__ !== 'function') return;
    while (queue.length) {
      const event = queue.shift();
      try { Promise.resolve(window.__QCHAT_EMIT__(event)).catch(() => deliveryFailed(event)); }
      catch (_) { deliveryFailed(event); }
    }
  }
  function emit(event) { queue.push(transportValue(event)); flush(); }
  setInterval(flush, 100);

  let active, loginCache = false, loginAt = -Infinity;
  const media = new Map();
  let mediaSerial = 0, inputSerial = 0, uploads = 0, uploadFailureAt = -Infinity, attachmentSelectionAt = -Infinity, cancelledAttachments, downloadActivation;

  function error(id, code, message) { emit({ type: 'error', ...(id == null ? {} : { id }), code, message }); }

  function detectLoggedIn() {
    const signIns = [...document.querySelectorAll('a, button, [role="button"]')].filter(node => {
      if (!shown(node)) return false;
      const text = (node.innerText || node.textContent || '').trim();
      const label = (node.getAttribute('aria-label') || '').trim();
      const href = node.getAttribute('href') || '';
      return /^sign in$/i.test(text) || /^sign in$/i.test(label) || /accounts\.google\.com\/ServiceLogin/i.test(href);
    });
    if (signIns.length > 0) return false;
    const navText = (document.querySelector('bard-sidenav, side-navigation-v2, side-navigation-content')?.innerText || '');
    if (/sign in to save activity/i.test(navText)) return false;
    const accountNodes = [...document.querySelectorAll(
      'a[aria-label*="Google Account" i], button[aria-label*="Google Account" i], [aria-label*="Google Account:" i], a[href*="SignOutOptions" i], img.gb_Q, .gb_B[aria-label*="Google Account" i]'
    )].filter(shown);
    return accountNodes.length > 0;
  }

  function loginInterval() {
    if (!find('composer') || /^\/(?:auth|login|signin)(?:\/|$)/.test(location.pathname)) return 5000;
    if (document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus())) return 60000;
    return loginCache ? 60000 : 30000;
  }
  function loginDue() { return Date.now() - loginAt >= loginInterval(); }

  // The current mode as the switcher shows it. Its first line is the name; an icon may follow.
  // Some layouts only say it in the label ("Open mode picker, currently Flash").
  function modelShort() {
    const node = document.querySelector('bard-mode-switcher button, button[data-test-id="bard-mode-menu-button"], button[aria-label*="mode picker" i]');
    if (!node) return undefined;
    const text = String(node.innerText || node.textContent || '').split('\n').map(line => line.trim()).find(Boolean);
    const labelled = /currently\s+(.+?)\s*$/i.exec(node.getAttribute('aria-label') || '')?.[1];
    return text || labelled || undefined;
  }

  let currentSetupId = null;
  async function status() {
    loginCache = detectLoggedIn();
    loginAt = Date.now();
    emit({ type: 'status', setupId: currentSetupId, temporary: temporaryReady(), ready: !!find('composer'), loggedIn: !!loginCache, authPending: false, url: location.href, model: modelShort() });
  }

  function completeActivity(job) {
    if (!job?.activity) return;
    emit({ type: 'activity', id: job.id, ...job.activity, state: 'complete' });
    job.activity = null;
    job.activityKey = null;
  }
  function startActivity(job, activity, key) {
    if (active !== job || job.finished || job.cancelled) return;
    if (job.activityKey === key && job.activity) return;
    if (job.activity) completeActivity(job);
    job.activityKey = key;
    job.activity = activity;
    emit({ type: 'activity', id: job.id, ...activity, state: 'running' });
  }

  function cancelTimers(job) {
    clearTimeout(job.watchdog);
    clearTimeout(job.startTimer);
    clearTimeout(job.deltaTimer);
    clearInterval(job.domTimer);
    job.observer?.disconnect();
    job.settle?.();
  }

  async function fail(job, code, message) {
    if (active !== job || job.finished || job.failing) return;
    job.failing = true;
    if (!job.started && job.attachmentCount > 0 && !job.cancelled) {
      job.cancelled = true;
      if (!await clearFailedAttachments(job) && code !== 'temporary_unavailable') {
        code = 'attachment_pending';
        message = 'Pending attachments could not be cleared. Remove them in Gemini or start a new chat before sending again.';
      }
      if (active !== job || job.finished) return;
    }
    if (job.text && job.text !== job.sentText) {
      emit({ type: 'delta', id: job.id, text: job.text });
      job.sentText = job.text;
    }
    completeActivity(job);
    job.finished = true;
    cancelTimers(job);
    active = null;
    error(job.id, code, message);
  }

  function progress(job) {
    if (active !== job || job.finished || job.failing) return;
    const now = Date.now();
    if (job.lastHeartbeat == null || now - job.lastHeartbeat >= 60000) {
      job.lastHeartbeat = now;
      emit({ type: 'progress', id: job.id });
    }
    clearTimeout(job.watchdog);
    job.watchdog = setTimeout(() => fail(job, 'timeout', 'No stream progress for five minutes.'), job.work ? 7200000 : 300000);
  }

  function delta(job, final = false) {
    clearTimeout(job.deltaTimer);
    const delay = 50 - (Date.now() - job.lastDelta);
    if (delay > 0 && !final) {
      job.deltaTimer = setTimeout(() => delta(job, false), delay);
      return;
    }
    const text = wellFormed(final ? job.text : job.text.replace(/[\uD800-\uDBFF]$/, ''));
    if (text !== job.sentText && (text || final)) {
      emit({ type: 'delta', id: job.id, text });
      job.sentText = text;
      job.lastDelta = Date.now();
    }
  }

  function currentConversationId() {
    const match = location.pathname.match(/^\/app\/([A-Za-z0-9_-]{8,80})(?:\/|$)/);
    return match ? match[1] : null;
  }

  async function finish(job, fallback = true) {
    if (active !== job || job.finished || job.finishing) return;
    job.finishing = true;
    if (fallback) {
      sampleDOM(job);
      if (!job.cancelled && (find('stop') || isStreamingNode(job.assistantNode))) {
        job.finishing = false;
        return;
      }
    }
    const imageDeadline = Date.now() + 4000;
    while (!job.cancelled && active === job && Date.now() < imageDeadline &&
      [...(job.assistantNode?.querySelectorAll('single-image, generated-image') || [])].some(n =>
        !safeURL(n.querySelector('img')?.currentSrc || n.querySelector('img')?.getAttribute('src') || ''))) {
      await sleep(100);
      sampleDOM(job);
    }
    sampleDOM(job);
    await sleep(Math.max(0, 50 - (Date.now() - job.lastDelta)));
    if (active !== job || job.finished) return;
    if (fallback && !job.cancelled && (find('stop') || isStreamingNode(job.assistantNode))) {
      job.finishing = false;
      return;
    }
    if (!job.cancelled && !job.text.trim() && !job.media?.size) {
      job.finishing = false;
      fail(job, 'stream_failed', 'Gemini returned an empty response.');
      return;
    }
    completeActivity(job);
    delta(job, true);
    job.finished = true;
    cancelTimers(job);
    active = null;
    if (job.media?.size) emit({ type: 'media', id: job.id, items: [...job.media.values()], final: true });
    if (!job.conversationId) job.conversationId = currentConversationId();
    emit({ type: 'done', id: job.id, text: job.text, conversationId: job.conversationId || null, rich: false });
  }

  function assistantNodes() {
    return [...document.querySelectorAll('model-response')].filter(node =>
      !node.closest('[hidden], [aria-hidden="true"]'));
  }

  function userNodes() {
    return [...document.querySelectorAll('user-query')].filter(node =>
      !node.closest('[hidden], [aria-hidden="true"]'));
  }

  function isStreamingNode(node) {
    if (!node) return false;
    const md = node.querySelector?.('message-content .markdown, .markdown-main-panel, .markdown');
    if (md?.classList?.contains('animate')) return true;
    const announcer = node.querySelector?.('.model-response-label-announcer, [aria-busy="true"]');
    if (announcer?.getAttribute?.('aria-busy') === 'true' || md?.getAttribute?.('aria-busy') === 'true') return true;
    return false;
  }

  function safeURL(raw) {
    if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) return null;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\r\n]+$/i.test(raw)) return raw;
    if (!/^(?:https:|blob:|\/(?!\/))/i.test(raw)) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === 'blob:' && url.origin === new URL(location.href).origin) return url.href;
      if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
          (/(^|\.)(?:gemini\.google\.com|googleusercontent\.com|ggpht\.com|gstatic\.com)$/.test(url.hostname))) return url.href;
    } catch (_) {}
    return null;
  }

  function mediaKind(name = '', mime = '') {
    if (/^(image\/(?!svg)|audio\/|video\/)/i.test(mime)) return mime.split('/')[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#]|$)/i.test(name)) return 'image';
    if (/\.(mp3|wav|ogg|m4a|aac|flac)(?:[?#]|$)/i.test(name)) return 'audio';
    if (/\.(mp4|webm|mov)(?:[?#]|$)/i.test(name)) return 'video';
    return 'file';
  }

  function registerMedia(job, { url, kind = 'image', name = 'Image', mime, node, key }) {
    if (!job || (active !== job && !job.history) || job.finished) return null;
    const safe = safeURL(url);
    if (/svg|html/i.test(mime || '') || /\.(svg|html?)(?:[?#]|$)/i.test(`${url || ''} ${name}`)) kind = 'file';
    const identity = key || safe || url || `${kind}:${name}`;
    job.media ||= new Map();
    let entry = job.media.get(identity);
    if (!entry) {
      const label = String(name || (kind === 'image' ? 'Image' : 'Attachment')).replace(/(?:https?:|data:|blob:)\S+/gi, 'Image').trim().slice(0, 200);
      entry = {
        id: `qchat-media-${++mediaSerial}`,
        kind,
        name: label || (kind === 'image' ? 'Image' : 'Attachment'),
        revision: safe ? 1 : 0,
        pending: kind === 'image' && !safe,
        ...(typeof mime === 'string' ? { mime: mime.slice(0, 100) } : {})
      };
      job.media.set(identity, entry);
      media.set(entry.id, { ...entry, url: safe, source: url, node, scope: job });
    } else {
      const stored = media.get(entry.id);
      if (safe && safe !== stored.url) { stored.url = safe; stored.source = url; entry.revision++; }
      if (node) stored.node = node;
      if (kind === 'image' && safe) { entry.kind = stored.kind = kind; entry.pending = false; }
      if (mime) entry.mime = stored.mime = mime;
    }
    const items = [...job.media.values()];
    const signature = JSON.stringify(items);
    if (signature !== job.mediaSignature) {
      job.mediaSignature = signature;
      progress(job);
      emit({ type: 'media', id: job.id, items });
    }
    return entry.id;
  }

  function isDecorativeImage(node) {
    if (!node) return true;
    if (node.closest?.('sources-list, message-actions, response-container-header, user-profile-picture, mat-icon, gem-icon, button')) return true;
    const cls = String(node.className || '');
    if (/avatar|favicon|icon|logo|badge/i.test(cls)) return true;
    const src = node.currentSrc || node.src || node.getAttribute?.('src') || '';
    if ((!src && !node.closest?.('single-image, generated-image')) || /favicon|gstatic\.com\/.*(?:icon|logo|avatar|sparkle)/i.test(src)) return true;
    if (typeof node.naturalWidth === 'number' && node.naturalWidth > 0 && node.naturalWidth < 32 &&
        typeof node.naturalHeight === 'number' && node.naturalHeight > 0 && node.naturalHeight < 32) return true;
    return false;
  }

  function domMedia(job, root) {
    if (!root) return;
    for (const img of root.querySelectorAll?.('img') || []) {
      if (img.closest?.('[hidden], [aria-hidden="true"]') || isDecorativeImage(img)) continue;
      const url = img.currentSrc || img.src || img.getAttribute?.('src');
      if (!safeURL(url) || img.closest?.('a.image-source-link') || /^https:\/\/encrypted-tbn[0-9]*\.gstatic\.com\//.test(url)) continue;
      const name = (img.getAttribute?.('alt') || 'Image').trim() || 'Image';
      registerMedia(job, { url, kind: 'image', name, node: img, key: safeURL(url) });
    }
  }

  function collectDOMSources(job, root) {
    if (!job || !root) return;
    const container = root.querySelector?.('sources-list') || root;
    const links = [...(container.querySelectorAll?.('sources-list a[href], [data-test-id*="source" i] a[href], .source-card a[href], .citation-link[href]') || [])];
    if (!links.length) return;
    job.sources ||= new Map();
    for (const link of links) {
      if (link.closest?.('[hidden], [aria-hidden="true"]')) continue;
      const raw = link.href || link.getAttribute?.('href') || '';
      try {
        const parsed = new URL(raw, location.href);
        if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
        if (parsed.hostname === 'gemini.google.com' || parsed.hostname === 'accounts.google.com' || parsed.hostname === 'policies.google.com') continue;
        const url = parsed.href;
        const title = (link.innerText || link.textContent || link.getAttribute?.('aria-label') || parsed.hostname).trim().replace(/\s+/g, ' ').slice(0, 300) || parsed.hostname;
        if (!job.sources.has(url)) job.sources.set(url, { id: url, url, title });
      } catch (_) {}
    }
    const items = [...job.sources.values()];
    const signature = JSON.stringify(items);
    if (items.length && signature !== job.sourcesSignature) {
      job.sourcesSignature = signature;
      emit({ type: 'sources', id: job.id, items });
    }
  }

  const EXCLUDED_MD_SELECTOR = [
    'button', 'mat-icon', 'gem-icon', 'gem-icon-button', 'copy-button', 'regenerate-button',
    'message-actions', 'sources-list', 'thinking-overlay', 'model-response-disclaimers',
    'freemium-rag-disclaimer', 'election-info-disclaimer', 'finance-info-disclaimer',
    'sensitive-memories-banner', 'hallucination-disclaimer', 'freemium-file-upload-near-quota-disclaimer',
    'freemium-file-upload-quota-exceeded-disclaimer', 'gem-popover', 'mat-menu',
    'script', 'style', 'svg', 'iframe', '[hidden]', '[aria-hidden="true"]',
    '.cdk-visually-hidden', '.sr-only', '.screen-reader-model-response-label',
    '.screen-reader-user-query-label', '.model-response-label-announcer',
    '.table-footer', '.code-block-decoration .buttons'
  ].join(', ');

  function extractLanguage(codeBlockNode) {
    const header = codeBlockNode.querySelector?.('.code-block-decoration span, .header-formatted span, [data-test-id="code-block-language"]');
    const headerText = (header?.innerText || header?.textContent || '').trim();
    if (headerText && !/^(?:copy|download|run|edit)$/i.test(headerText)) {
      return headerText.toLowerCase().replace(/[^a-z0-9+#._-]/g, '');
    }
    const code = codeBlockNode.querySelector?.('pre code, code');
    const cls = code?.className || '';
    const match = cls.match(/language-([\w+#.-]+)/i);
    return match ? match[1].toLowerCase() : '';
  }

  function extractMath(node) {
    const direct = node.getAttribute?.('data-math');
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const ann = node.querySelector?.('annotation[encoding="application/x-tex"], annotation');
    if (ann && (ann.textContent || '').trim()) return ann.textContent.trim();
    const child = node.querySelector?.('[data-math]');
    if (child) {
      const val = child.getAttribute?.('data-math');
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
  }

  function isDisplayMath(node) {
    const cls = String(node.className || '');
    if (/math-block|katex-display|display-math/i.test(cls)) return true;
    if (node.getAttribute?.('display') === 'block' || node.getAttribute?.('data-display') === 'true') return true;
    if (node.querySelector?.('.katex-display, math[display="block"]')) return true;
    const tag = node.tagName?.toLowerCase() || '';
    return tag === 'math-block' || (tag === 'div' && /math/i.test(cls));
  }

  function htmlToMarkdown(root, options = {}) {
    if (!root) return '';
    const job = options.job || null;
    const fence = (text, min = 3) => '`'.repeat(Math.max(min, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length + 1)));

    const walk = (node, listDepth = 0, inTable = false) => {
      if (!node) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      const tag = (node.tagName || '').toLowerCase();

      if (node.matches?.(EXCLUDED_MD_SELECTOR)) return '';
      const cls = String(node.className || '');
      if (/\b(?:cdk-visually-hidden|sr-only|screen-reader-model-response-label|screen-reader-user-query-label|model-response-label-announcer|table-footer)\b/.test(cls)) return '';
      if (node.hasAttribute?.('hidden') || node.getAttribute?.('aria-hidden') === 'true' || (node.hasAttribute?.('hide-from-message-actions') && !node.closest?.('single-image, generated-image'))) return '';

      // Math handling before generic children traversal so .katex-html (or MathML glyphs) are never emitted
      if (/\b(?:math-inline|math-block|katex-display|katex)\b/.test(cls) || node.hasAttribute?.('data-math') || tag === 'math') {
        const tex = extractMath(node);
        if (tex) {
          return isDisplayMath(node) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
        }
      }

      // Gemini code-block wrapper
      if (tag === 'code-block' || /\bformatted-code-block-internal-container\b/.test(cls)) {
        const lang = extractLanguage(node);
        const codeEl = node.querySelector?.('pre code, code[data-test-id="code-content"], pre') || node;
        const codeText = (codeEl.textContent || '').replace(/\n$/, '');
        const ticks = fence(codeText, 3);
        return `\n\n${ticks}${lang}\n${codeText}\n${ticks}\n\n`;
      }
      if (/\bcode-block-decoration\b/.test(cls)) return '';

      if (tag === 'pre') {
        const codeEl = node.querySelector?.('code') || node;
        const codeText = (codeEl.textContent || '').replace(/\n$/, '');
        let lang = (codeEl.className || '').match(/language-([\w+#.-]+)/i)?.[1]?.toLowerCase() || '';
        if (!lang && node.parentElement) lang = extractLanguage(node.parentElement);
        const ticks = fence(codeText, 3);
        return `\n\n${ticks}${lang}\n${codeText}\n${ticks}\n\n`;
      }

      if (tag === 'code') {
        const text = node.textContent || '';
        const ticks = fence(text, 1);
        const pad = text.includes('`') || /^ | $/.test(text) ? ' ' : '';
        return `${ticks}${pad}${text}${pad}${ticks}`;
      }

      if (tag === 'br') return inTable ? ' ' : '\n';
      if (tag === 'hr') return '\n\n---\n\n';

      if (tag === 'a' && node.matches?.('.image-source-link')) {
        const image = node.querySelector('img');
        const href = node.href || '';
        const caption = (image?.getAttribute('alt') || 'Image').replace(/[\[\]\r\n]/g, ' ');
        return image ? `\n\n${walk(image)}\n\n${/^https?:/.test(href) ? `[${caption}](${href})` : ''}\n\n` : '';
      }
      if (tag === 'img') {
        if (isDecorativeImage(node)) return '';
        const url = node.currentSrc || node.src || node.getAttribute?.('src') || '';
        const alt = (node.getAttribute?.('alt') || 'Image').replace(/[\[\]\r\n]/g, ' ').trim() || 'Image';
        const safeWeb = safeURL(url);
        if (safeWeb && /^https:/.test(safeWeb) && (node.closest?.('a.image-source-link') || /^encrypted-tbn[0-9]*\.gstatic\.com$/.test(new URL(safeWeb).hostname))) {
          return `![${alt}](qchat-web:${btoa(safeWeb).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')})`;
        }
        if (job) {
          const id = registerMedia(job, { url, kind: 'image', name: alt, node, key: safeURL(url) || url });
          if (id) return `![${alt}](qchat-media:${id})`;
        }
        const safe = safeURL(url);
        return safe && /^https:/i.test(safe) ? `![${alt}](${safe})` : '';
      }

      const inner = (from = node) => [...(from.childNodes || [])].map(child => walk(child, listDepth, inTable)).join('');

      if (/^h[1-6]$/.test(tag)) {
        const text = inner().trim();
        if (!text || /^(?:Gemini|You) said$/i.test(text)) return '';
        return `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`;
      }

      if (tag === 'p') {
        const text = inner().trim();
        if (!text) return '';
        if (inTable) return text;
        return `\n\n${text}\n\n`;
      }

      if (tag === 'strong' || tag === 'b') {
        const content = inner();
        if (!content.trim()) return content;
        const lead = content.match(/^\s*/)[0], trail = content.match(/\s*$/)[0];
        return `${lead}**${content.trim()}**${trail}`;
      }

      if (tag === 'em' || tag === 'i') {
        const content = inner();
        if (!content.trim()) return content;
        const lead = content.match(/^\s*/)[0], trail = content.match(/\s*$/)[0];
        return `${lead}*${content.trim()}*${trail}`;
      }

      if (tag === 'del' || tag === 's') {
        const content = inner();
        if (!content.trim()) return content;
        return `~~${content.trim()}~~`;
      }

      if (tag === 'a') {
        const text = inner().trim();
        const rawHref = node.href || node.getAttribute?.('href') || '';
        try {
          const parsed = new URL(rawHref, location.href);
          if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
            const cleanUrl = parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
            return `[${text || cleanUrl}](${cleanUrl})`;
          }
        } catch (_) {}
        return text;
      }

      if (tag === 'blockquote') {
        const text = inner().trim();
        if (!text) return '';
        return `\n\n${text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      }

      if (tag === 'ul' || tag === 'ol') {
        const start = Number(node.getAttribute?.('start')) || 1;
        const items = [...(node.children || node.childNodes || [])].filter(child => (child.tagName || '').toLowerCase() === 'li');
        const lines = items.map((item, idx) => {
          const marker = tag === 'ol' ? `${start + idx}. ` : '- ';
          const indent = '  '.repeat(listDepth);
          const childParts = [];
          for (const child of item.childNodes || []) {
            const cTag = (child.tagName || '').toLowerCase();
            if (cTag === 'ul' || cTag === 'ol') {
              const nested = walk(child, listDepth + 1, inTable).replace(/^\n+|\n+$/g, '');
              if (nested) childParts.push('\n' + nested);
            } else {
              childParts.push(walk(child, listDepth + 1, inTable));
            }
          }
          const body = childParts.join('').trim().replace(/\n{3,}/g, '\n\n');
          const formatted = body.split('\n').map((line, lineIdx) => lineIdx === 0 ? `${indent}${marker}${line}` : (line.startsWith('  ') ? line : `${indent}${' '.repeat(marker.length)}${line}`)).join('\n');
          return formatted;
        });
        return listDepth === 0 ? `\n\n${lines.join('\n')}\n\n` : `\n${lines.join('\n')}\n`;
      }

      if (tag === 'table') {
        const trs = [...(node.rows || node.querySelectorAll?.('tr') || [])];
        if (!trs.length) return '';
        const rows = trs.map(row => {
          const cells = [...(row.cells || row.querySelectorAll?.('th, td') || [])];
          return `| ${cells.map(cell => walk(cell, listDepth, true).trim().replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ')).join(' | ')} |`;
        });
        const colCount = (trs[0].cells || trs[0].querySelectorAll?.('th, td') || []).length || 1;
        rows.splice(1, 0, `|${' --- |'.repeat(colCount)}`);
        return `\n\n${rows.join('\n')}\n\n`;
      }

      return inner();
    };

    return walk(root, 0, false)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function currentAssistants(job) {
    if (!job.submitted) return [];
    return assistantNodes().filter(node => !job.previousAssistants.has(node));
  }

  function detectActivity(root) {
    if (!root) return null;
    const thinking = root.querySelector?.('thinking-overlay, [data-test-id*="thinking" i], .thinking-progress, .processing-state');
    if (thinking && shown(thinking)) {
      const label = (thinking.innerText || thinking.textContent || thinking.getAttribute?.('aria-label') || '').trim();
      if (/search|web|google/i.test(label)) return { kind: 'search', label: 'Searching the web' };
      if (/code|python|run/i.test(label)) return { kind: 'code', label: 'Running code' };
      if (/read|browse|source/i.test(label)) return { kind: 'browse', label: 'Reading sources' };
      if (label || thinking.children?.length) return { kind: 'tool', label: 'Using a tool' };
    }
    const statusNodes = [...(root.querySelectorAll?.('[role="status"], [aria-live], .response-container-header-processing-state, .response-container-header-status') || [])];
    for (const st of statusNodes) {
      if (!shown(st) || st.classList?.contains('markdown') || st.classList?.contains('model-response-label-announcer')) continue;
      const text = (st.innerText || st.textContent || st.getAttribute?.('aria-label') || '').trim();
      if (!text) continue;
      if (/search|looking up|google/i.test(text)) return { kind: 'search', label: 'Searching the web' };
      if (/browse|reading/i.test(text)) return { kind: 'browse', label: 'Reading sources' };
      if (/running|executing|code|python/i.test(text)) return { kind: 'code', label: 'Running code' };
      if (/thinking|reasoning|analyzing|working/i.test(text)) return { kind: 'tool', label: 'Using a tool' };
    }
    return null;
  }

  function sampleDOM(job) {
    if (active !== job || job.finished || job.cancelled) return;
    const block = blocking();
    if (block) { fail(job, ...block); return; }

    const stopBtn = find('stop');
    const nodes = currentAssistants(job);
    const users = userNodes().filter(u => !job.previousUsers.has(u));
    const node = nodes[nodes.length - 1];
    job.assistantNode = node;

    if (!job.started && (stopBtn || nodes.length > 0 || users.length > 0)) {
      job.started = true;
      clearTimeout(job.startTimer);
      progress(job);
      emit({ type: 'start', id: job.id });
    }

    if (!job.started) return;

    const convId = currentConversationId();
    if (convId) job.conversationId = convId;

    const domAct = detectActivity(node || document);
    if (domAct && !job.text) {
      startActivity(job, domAct, `dom:${domAct.kind}`);
    } else if (!domAct && job.activityKey?.startsWith('dom:')) {
      completeActivity(job);
    }

    if (node) {
      const generating = !!node.querySelector('generated-image [role="progressbar"], generated-image .loading, image-generation-progress, .image-generation-progress');
      if (job.imageGenerating !== generating && (generating || job.imageGenerating)) {
        job.imageGenerating = generating;
        emit({ type: 'image_progress', id: job.id, state: generating ? 'generating' : 'complete' });
      }
      domMedia(job, node);
      collectDOMSources(job, node);
      const body = node;
      const md = htmlToMarkdown(body, { job });
      if (md && md !== job.domText) {
        job.domText = md;
        job.text = md;
        job.stableAt = Date.now();
        progress(job);
        if (job.activity) completeActivity(job);
        delta(job, false);
      } else if (!job.stableAt && (md || job.media?.size)) {
        job.stableAt = Date.now();
      }
    }

    const streaming = !!stopBtn || isStreamingNode(node);
    if (streaming) {
      job.sawStream = true;
      job.idleAt = null;
    } else if (node) {
      job.idleAt ||= Date.now();
    }

    if (job.work && modeAttention(node)) {
      // The follow-up needs this thread on record, and a paused task never reaches done.
      const pausedIn = currentConversationId();
      if (pausedIn) emit({ type: 'conversation', id: job.id, conversationId: pausedIn });
      fail(job, 'needs_attention', 'Gemini Spark is waiting for your approval. Open the chat in Gemini to continue.');
      return;
    }

    const stableFor = Date.now() - (job.stableAt || job.idleAt || Date.now());
    const idleFor = job.idleAt ? Date.now() - job.idleAt : 0;
    if (job.work) {
      // A task can pause between steps, so quiet only counts for long, and for far longer if it was never seen streaming.
      const workQuiet = job.sawStream ? 15000 : 600000;
      if (node && !streaming && stableFor >= workQuiet && idleFor >= workQuiet) finish(job);
    } else if (node && !streaming && idleFor >= 1000 && stableFor >= 1000) {
      finish(job, true);
    }
  }

  function blocking() {
    const quotaEls = [
      ...document.querySelectorAll('freemium-file-upload-quota-exceeded-disclaimer, remy-access-restricted-banner, [role="alert"], [role="dialog"], mat-snack-bar-container, .mat-mdc-snack-bar-container')
    ].filter(shown);
    for (const el of quotaEls) {
      const text = (el.innerText || el.textContent || '').trim();
      if (/quota|reached.*limit|usage limit|too many requests|try again later|rate limit/i.test(text)) {
        return ['rate_limited', 'You have reached your Gemini usage limit.'];
      }
      if (/sign in to continue|session expired|must sign in/i.test(text) && !find('composer')) {
        return ['auth', 'Sign in to Gemini to continue.'];
      }
    }
    return null;
  }

  function conversationNodes() {
    const nodes = [...assistantNodes(), ...userNodes()];
    if (!nodes.length) return [];
    return nodes.sort((a, b) => {
      if (typeof a.compareDocumentPosition === 'function') {
        return a.compareDocumentPosition(b) & 4 ? -1 : 1;
      }
      return 0;
    });
  }

  function cleanUserText(node) {
    if (!node) return '';
    const clone = node.cloneNode ? node.cloneNode(true) : null;
    if (clone?.querySelectorAll) {
      clone.querySelectorAll('.cdk-visually-hidden, .sr-only, .screen-reader-user-query-label, button, mat-icon, gem-icon').forEach(n => n.remove());
      return (clone.innerText || clone.textContent || '').trim();
    }
    const raw = (node.innerText || node.textContent || '').trim();
    return raw.replace(/^You said\s+/i, '').trim();
  }

  function conversationMessages() {
    return conversationNodes().map(node => {
      const tag = (node.tagName || '').toLowerCase();
      const isUser = tag === 'user-query' || node.matches?.('user-query');
      if (isUser) {
        const body = node.querySelector?.('.query-text, user-query-content') || node;
        const text = cleanUserText(body);
        const hasMedia = !!(node.querySelector?.('.file-preview-container img, .file-preview-container [data-test-id*="file"], img'));
        return { role: 'user', text, hasMedia };
      }
      const body = node;
      const text = htmlToMarkdown(body, { job: { history: true, id: 'history', media: new Map() } });
      const imgs = [...(body.querySelectorAll?.('img') || [])].filter(img => !isDecorativeImage(img));
      return { role: 'assistant', text, hasMedia: imgs.length > 0 };
    }).filter(item => item.text || item.hasMedia);
  }

  // Gemini can open a promo dialog (such as its guest log-in nudge) that silently swallows Send.
  function dismissNudges() {
    let dismissed = false;
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"], mat-dialog-container')) {
      if (!shown(dialog)) continue;
      const button = [...dialog.querySelectorAll('button')].find(node =>
        /^(not now|no thanks|maybe later|got it|dismiss)$/i.test((node.innerText || node.textContent || '').trim()));
      if (button) { button.click(); dismissed = true; }
    }
    return dismissed;
  }

  // A Send that did not take leaves the prompt in the composer and no new turn. Only then may it be
  // clicked again, so one prompt can never be sent twice.
  async function confirmSend(job, composer) {
    for (let i = 0; i < 12 && active === job && !job.started && !job.cancelled; i++) {
      await sleep(1500);
      sampleDOM(job);
      if (active !== job || job.started || job.cancelled) return;
      dismissNudges();
      await sleep(200);
      sampleDOM(job);
      if (active !== job || job.started || job.cancelled) return;
      const button = find('send');
      const pending = (composer.innerText || composer.value || composer.textContent || '').trim();
      if (pending && button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') button.click();
    }
  }

  // Gemini has one real model menu, so its operations run strictly one at a time.
  let modelQueue = Promise.resolve(), modelOps = 0, modelChoice = 0, modelListing = null;
  function enqueueModelOp(task) {
    modelOps++;
    modelQueue = modelQueue.then(task).catch(() => {}).finally(() => { modelOps--; });
    return modelQueue;
  }
  const modelSwitcher = () => {
    const node = document.querySelector('bard-mode-switcher button, button[data-test-id="bard-mode-menu-button"], button[aria-label*="mode picker" i]');
    return node && !node.hidden ? node : null;
  };
  function modelMenuItems(switcher) {
    const controlledId = switcher.getAttribute('aria-controls');
    const menu = (controlledId && document.getElementById?.(controlledId)) ||
      document.querySelector('gem-menu[role="menu"], .cdk-overlay-container [role="menu"], .cdk-overlay-container [role="listbox"]');
    if (!menu || menu.hidden) return [];
    return [...menu.querySelectorAll('gem-menu-item[role="menuitem"], [role="menuitemradio"], [role="menuitem"], [role="option"]')]
      .filter(n => !n.hidden && n.getAttribute('aria-hidden') !== 'true');
  }
  async function openModelMenu(switcher) {
    // The menu opens a moment after the click, and a second click would toggle it shut.
    if (switcher.getAttribute('aria-expanded') !== 'true') dispatchClickSequence(switcher, true);
    for (let i = 0; i < 60; i++) {
      const nodes = modelMenuItems(switcher);
      if (nodes.length) return nodes;
      if (switcher.getAttribute('aria-expanded') !== 'true') {
        if (i === 20) {
          switcher.focus?.();
          switcher.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
        } else if (i === 40) {
          switcher.click?.();
        }
      }
      await sleep(25);
    }
    return [];
  }
  // Waits for the menu to finish closing, so the next operation starts from a known state.
  async function closeModelMenu(switcher) {
    const escape = node => node?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    const open = () => (modelSwitcher() || switcher).getAttribute('aria-expanded') === 'true';
    if (!open()) return;
    escape(document.activeElement || switcher);
    document.querySelector('.cdk-overlay-backdrop')?.click?.();
    for (let i = 0; i < 16 && open(); i++) {
      await sleep(25);
      if (i === 4) escape(modelSwitcher() || switcher);
    }
  }
  function parseModelItem(node) {
    const labelEl = node.querySelector?.('.label, .title, [data-test-id*="label"]');
    const rawText = (labelEl ? (labelEl.innerText || labelEl.textContent) : (node.innerText || node.textContent) || '').trim();
    const label = rawText.split('\n')[0].trim();
    const content = node.querySelector?.('gem-menu-item-content');
    const disabled = !!(node.disabled || node.getAttribute('aria-disabled') === 'true' ||
      /\bdisabled\b/.test(String(node.className || '')) || /\bdisabled\b/.test(String(content?.className || '')));
    const selected = !!(node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true' ||
      /\bselected\b/.test(String(node.className || '')) || /\bselected\b/.test(String(content?.className || '')) ||
      node.querySelector?.('[aria-label="Selected"]'));
    const meta = (node.querySelector?.('.sublabel')?.textContent || '').trim();
    const group = node.closest?.('[role="group"], [role="listbox"], section');
    const heading = group?.querySelector?.('[role="heading"], h2, h3, .group-title')?.textContent || group?.getAttribute?.('aria-label') || '';
    return { id: label, label, selected, disabled, meta, level: /think|reason|effort/i.test(heading), node };
  }
  // Whole words only: "Flash" must not match a switcher that still reads "Flash-Lite".
  function switcherShows(switcher, label) {
    const words = text => ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
    const current = words(switcher.innerText || switcher.textContent) + words(switcher.getAttribute('aria-label'));
    const full = label.toLowerCase(), short = full.replace(/^\d+(?:\.\d+)?\s+/, '');
    return current.includes(' ' + full + ' ') || (!!short && current.includes(' ' + short + ' '));
  }
  async function runModelMenu(chooseId, choice) {
    let switcher, opened = false;
    const unavailable = () => {
      if (chooseId === undefined) emit({ type: 'models', models: [], error: 'unavailable' });
      else if (choice === modelChoice) error(undefined, 'model_unavailable', 'Could not switch Gemini model.');
    };
    try {
      if (active) { unavailable(); return; }
      for (let i = 0; i < 30 && !(switcher = modelSwitcher()); i++) await sleep(100);
      if (!switcher) { unavailable(); return; }
      opened = true;
      const nodes = await openModelMenu(switcher);
      if (!nodes.length) { unavailable(); return; }
      const parsed = nodes.map(parseModelItem).filter(item => item.label && !/^sign in\b/i.test(item.label));
      if (!parsed.length) { unavailable(); return; }
      if (chooseId === undefined) {
        const pack = ({ id, label, selected, disabled, meta }) => ({ id, label, selected, disabled, meta });
        emit({ type: 'models', models: parsed.filter(p => !p.level).map(pack), levels: parsed.filter(p => p.level).map(pack) });
        return;
      }
      const wanted = String(chooseId).toLowerCase();
      const target = parsed.find(m => m.id === chooseId || m.label === chooseId) || parsed.find(m => m.label.toLowerCase().includes(wanted));
      if (!target || target.disabled) { unavailable(); return; }
      const applied = () => (!target.level && switcherShows(modelSwitcher() || switcher, target.label)) ||
        (target.node.isConnected && parseModelItem(target.node).selected);
      let verified = target.selected;
      if (!verified) {
        dispatchClickSequence(target.node, true);
        for (let i = 0; i < 40 && !verified; i++) {
          await sleep(25);
          verified = applied();
          if (!verified && i === 12 && target.node.isConnected) target.node.click?.();
        }
      }
      if (!verified) {
        // The menu may have closed on its choice, and only its rows record a reasoning level.
        await closeModelMenu(switcher);
        switcher = modelSwitcher() || switcher;
        verified = (await openModelMenu(switcher)).map(parseModelItem).some(m => m.label === target.label && m.selected);
      }
      if (!verified) { unavailable(); return; }
      await status();
      emit({ type: 'model-chosen', short: modelShort(), model: { id: target.id, label: target.label, selected: true } });
    } catch (_) {
      unavailable();
    } finally {
      if (opened) await closeModelMenu(switcher).catch(() => {});
    }
  }

  function dispatchClickSequence(node, once = false) {
    if (!node) return;
    const wasExpanded = node.getAttribute?.('aria-expanded');
    if (typeof node.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0 }));
        if (wasExpanded === 'false' && node.getAttribute?.('aria-expanded') === 'true') return;
      }
    }
    if (once) return;
    if (wasExpanded === 'false' && node.getAttribute?.('aria-expanded') === 'true') return;
    if (typeof node.click === 'function') {
      try { node.click(); } catch (_) {}
    }
  }

  // Chat and Spark are read from the page's own switch. Only that exact control is clicked.
  const MODE_MESSAGE = "Gemini Spark isn't available on this account right now.";
  const modeSelector = '[role="tab"], [role="radio"], [role="menuitemradio"], button, a[role]';
  const modeExcluded = '[data-message-author-role], [data-message-role], user-query, model-response, nav a[href*="/c/"], [data-testid^="history-item"], conversations-list, .conversation, [contenteditable="true"]';
  const modeShown = node => shown(node) && !node.closest?.(modeExcluded);
  const modeName = node => {
    const text = String(node.innerText ?? node.textContent ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';
    const label = String(node.getAttribute?.('aria-label') || '').split('\n')[0].trim();
    return { text, label };
  };
  const modeMatch = (node, pattern) => { const { text, label } = modeName(node); return pattern.test(text) || pattern.test(label); };
  const modeLabel = node => { const { text, label } = modeName(node); return text || label; };
  const modeCandidates = pattern => [...document.querySelectorAll(modeSelector)].filter(node =>
    modeShown(node) && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' && modeMatch(node, pattern));
  const modeRole = node => /^(?:tab|radio|menuitemradio)$/i.test(node.getAttribute?.('role') || '');
  // A Spark tab and the chat tab normally share the switch that contains both.
  const modeNear = (a, b) => {
    if (!a || !b) return false;
    for (let node = a, depth = 0; node && depth <= 3; node = node.parentElement, depth++)
      for (let other = b; other; other = other.parentElement) if (other === node) return true;
    return false;
  };
  function modeControls() {
    const chat = modeCandidates(/^chat$/i), work = modeCandidates(/^(?:spark|tasks?|agent)$/i);
    const pick = (nodes, other) => {
      if (nodes.length <= 1) return nodes[0] || null;
      const near = other ? nodes.filter(node => modeNear(node, other)) : [];
      const pool = near.length ? near : nodes;
      const roled = pool.filter(modeRole);
      return roled.length === 1 ? roled[0] : pool.length === 1 ? pool[0] : null;
    };
    const chatNode = pick(chat, work[0]);
    return { chat: chatNode, work: pick(work, chatNode) };
  }
  const modeFlag = node => {
    if (!node) return null;
    const attr = key => node.getAttribute?.(key);
    if (attr('aria-selected') === 'true' || attr('aria-checked') === 'true' || attr('aria-current') === 'true' ||
        attr('aria-current') === 'page' || attr('aria-pressed') === 'true' || ['active', 'on'].includes(attr('data-state'))) return true;
    if (attr('aria-selected') === 'false' || attr('aria-checked') === 'false' || attr('aria-pressed') === 'false' || ['inactive', 'off'].includes(attr('data-state'))) return false;
    return null;
  };
  function modeState(controls) {
    const chat = modeFlag(controls.chat), work = modeFlag(controls.work);
    if (chat === true && work !== true) return 'chat';
    if (work === true && chat !== true) return 'work';
    if (chat === true && work === true) return null;
    if (chat === false && work !== false) return 'work';
    if (work === false && chat !== false) return 'chat';
    return null;
  }
  function modeReport() {
    const controls = modeControls(), state = modeState(controls);
    return { type: 'modes', available: !!controls.work, modes: [
      { id: 'chat', label: controls.chat ? modeLabel(controls.chat) : 'Chat', selected: state !== 'work' },
      { id: 'work', label: controls.work ? modeLabel(controls.work) : 'Spark', selected: state === 'work' }
    ] };
  }
  function listModes() { emit(modeReport()); }
  const inConversation = () => !!currentConversationId();
  const modeSign = () => {
    const composer = find('composer');
    const hint = composer?.querySelector?.('[data-placeholder]')?.getAttribute?.('data-placeholder') || composer?.getAttribute?.('data-placeholder') || composer?.getAttribute?.('placeholder') || composer?.getAttribute?.('aria-label') || '';
    return `${location.pathname}|${hint}`;
  };
  async function ensureMode(job, mode) {
    const alive = () => !job || (active === job && !job.cancelled && !job.finished);
    const deny = () => {
      if (job) fail(job, 'mode_unavailable', MODE_MESSAGE);
      // Carries the mode, so a late failure can't cancel a newer pick.
      else emit({ type: 'error', code: 'mode_unavailable', message: MODE_MESSAGE, mode });
      return false;
    };
    // Only the exact thread QChat recorded as a Work chat may continue here.
    if (job && mode === 'work' && inConversation() && !(job.expectedConversation && location.pathname.includes(job.expectedConversation))) return deny();
    let controls = modeControls();
    if (!controls[mode]) {
      // A missing Spark switch is only safe inside a thread, which keeps its own mode.
      if (mode === 'chat') return true;
      if (inConversation()) return true;
      for (let i = 0; i < 30 && alive(); i++) {
        await sleep(100);
        controls = modeControls();
        if (controls.work) break;
      }
      if (!controls.work) return alive() ? deny() : false;
    }
    const before = modeState(controls);
    // Unknown state counts as chat; work must be clicked, chat need not be.
    if (mode === 'chat' && before !== 'work') return true;
    if (mode === 'work' && before === 'work') return true;
    const target = controls[mode];
    if (!target) return true;
    // With no readable selection, the page has to change visibly before a prompt can go out.
    const signBefore = modeSign();
    try { dispatchClickSequence(target, true); } catch (_) { return deny(); }
    let verified = false;
    for (let i = 0; i < 30 && !verified && alive(); i++) {
      await sleep(100);
      if (modeState(modeControls()) === mode || (before === null && modeSign() !== signBefore)) verified = true;
    }
    // A drawer tab can navigate; a composer on the new page is the proof it settled.
    let composer = find('composer');
    for (let i = 0; i < 50 && !composer && alive(); i++) { await sleep(100); composer = find('composer'); }
    if (!alive()) return false;
    return composer && verified ? true : deny();
  }
  const modeAttention = node => [...(node?.querySelectorAll('button, [role="button"]') || [])].find(button =>
    !!button.getClientRects?.().length && !button.closest?.('[hidden], [aria-hidden="true"]') &&
    /^(?:approve|allow|confirm|continue|review)\b/i.test(
      String(button.innerText ?? button.textContent ?? button.getAttribute?.('aria-label') ?? '').trim().split('\n')[0].trim()));

  function attachmentRemovers(names = [], includeDisabled = false) {
    return [...document.querySelectorAll('button')].filter(node => {
      if (!includeDisabled && (node.disabled || node.getAttribute('aria-disabled') === 'true')) return false;
      const label = (node.getAttribute('aria-label') || '').trim();
      const testid = node.getAttribute('data-test-id') || node.getAttribute('data-testid') || '';
      return /^remove (?:file|attachment|image)(?:\b|$)/i.test(label) || /^remove-(?:file|attachment|image)/i.test(testid) ||
        names.some(name => label.toLowerCase().includes(name.toLowerCase()) && /remove|delete|cancel/i.test(label));
    });
  }
  async function clearFailedAttachments(job) {
    const controls = attachmentRemovers(job.attachmentNames);
    cancelledAttachments = { names: job.attachmentNames, hadControls: controls.length >= job.attachmentCount };
    let clicked = true;
    controls.forEach(node => { try { node.click(); } catch (_) { clicked = false; } });
    if (!cancelledAttachments.hadControls || !clicked) return false;
    for (let i = 0; i < 20 && active === job && !job.finished; i++) {
      if (uploads === 0 && attachmentRemovers(job.attachmentNames).length === 0) { cancelledAttachments = null; return true; }
      await sleep(50);
    }
    return false;
  }

  function temporaryReady() {
    const composer = find('composer');
    const host = composer?.closest('chat-window');
    return !!(detectLoggedIn() && shown(composer) && shown(host) && host.classList.contains('is-temporary-chat'));
  }
  let temporaryStage = null, stageEpoch = 0;
  function clearTemporaryStage(id) {
    if (!id || temporaryStage?.id === id) {
      if (temporaryStage) temporaryStage.detached.value = '';
      temporaryStage = null;
      stageEpoch++;
    }
  }
  async function stageTemporaryFiles(id) {
    clearTemporaryStage();
    const epoch = stageEpoch;
    if (!temporaryReady()) throw new Error('temporary_unavailable');
    const selector = await attachmentInput();
    if (epoch !== stageEpoch || !temporaryReady()) throw new Error('temporary_unavailable');
    const real = document.querySelector(selector), composer = find('composer');
    if (!real?.isConnected || !composer) throw new Error('temporary_unavailable');
    const detached = document.createElement('input');
    detached.type = 'file'; detached.multiple = true;
    temporaryStage = { id, real, composer, detached };
    return detached;
  }
  function commitTemporaryFiles(id) {
    const stage = temporaryStage;
    if (!stage || stage.id !== id) return false;
    try {
      if (!temporaryReady() || !stage.real.isConnected || find('composer') !== stage.composer || document.querySelector(`[data-qchat-file-input="${stage.real.getAttribute('data-qchat-file-input')}"]`) !== stage.real) return false;
      const transfer = new DataTransfer();
      for (const file of stage.detached.files) transfer.items.add(file);
      stage.real.files = transfer.files;
      stage.real.dispatchEvent(new Event('input', { bubbles: true }));
      stage.real.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } finally { clearTemporaryStage(id); }
  }
  async function attachmentInput() {
    loginCache = detectLoggedIn();
    if (!loginCache) {
      error(undefined, 'attachment_unavailable', 'Sign in to Gemini to attach files.');
      const err = new Error('attachment_unavailable: Sign in to Gemini to attach files.');
      err.code = 'attachment_unavailable';
      throw err;
    }
    if (cancelledAttachments) {
      if (cancelledAttachments.hadControls && uploads === 0 && attachmentRemovers(cancelledAttachments.names).length === 0) cancelledAttachments = null;
      else throw new Error('attachment_pending: Start a new chat to clear cancelled attachments before uploading again.');
    }
    attachmentSelectionAt = Date.now();
    const choose = () => {
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter(input => !input.disabled);
      return inputs.find(input => !input.accept || input.accept === '*/*') ||
        inputs.find(input => !/^image\//i.test(input.accept || '')) || inputs[0];
    };
    let input = choose();
    if (!input) {
      const uploadBtn = [...document.querySelectorAll('button')].find(node =>
        shown(node) && /upload|add files|attach/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-test-id') || ''}`));
      if (uploadBtn && !uploadBtn.disabled) {
        uploadBtn.click();
        for (let i = 0; i < 20 && !(input = choose()); i++) await sleep(100);
        // Close menu overlay if it opened
        document.querySelector('.cdk-overlay-backdrop')?.click?.();
      }
    }
    if (!input) {
      error(undefined, 'attachment_unavailable', 'Sign in to Gemini to attach files.');
      const err = new Error('attachment_unavailable: Sign in to Gemini to attach files.');
      err.code = 'attachment_unavailable';
      throw err;
    }
    const token = `qchat-file-input-${++inputSerial}`;
    input.setAttribute('data-qchat-file-input', token);
    return `input[type="file"][data-qchat-file-input="${token}"]`;
  }

  function cancelAttachmentSelection(count) {
    if (active) return;
    const names = [...document.querySelectorAll('input[type="file"]')].flatMap(input => [...(input.files || [])].map(file => file.name));
    if (!names.length && !uploads) return;
    const controls = attachmentRemovers(names);
    cancelledAttachments = { names, hadControls: controls.length >= count };
    controls.forEach(node => { try { node.click(); } catch (_) {} });
  }

  function mediaInfo(id) {
    const entry = media.get(id);
    if (!entry) throw new Error('This attachment is unavailable. View it in Gemini.');
    return transportValue({ kind: entry.kind, name: entry.name, ...(entry.mime ? { mime: entry.mime } : {}) });
  }

  function mediaDownloadAction() {
    return null;
  }

  async function activateMedia(id) {
    const entry = media.get(id);
    if (!entry) throw new Error('This attachment is unavailable. View it in Gemini.');
    throw new Error('This attachment download is unavailable. View it in Gemini.');
  }

  async function resolveMedia(id) {
    const entry = media.get(id);
    if (!entry) throw new Error('This attachment is unavailable. View it in Gemini.');
    const url = safeURL(entry.node?.currentSrc || entry.node?.src || entry.node?.href || entry.url);
    if (!url) throw new Error('This attachment cannot be downloaded here. View it in Gemini.');
    let resolved = url;
    if (/^https:/.test(url) && entry.kind === 'image') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type) || blob.size > 32 * 1024 * 1024) throw new Error('Unsupported image');
        resolved = URL.createObjectURL(blob);
        entry.url = resolved;
      } finally { clearTimeout(timer); }
    }
    return { url: resolved, kind: entry.kind, name: entry.name, ...(entry.mime ? { mime: entry.mime } : {}) };
  }

  window.__qchat = {
    _htmlToMarkdown: htmlToMarkdown,
    attachmentInput, temporaryReady, stageTemporaryFiles, commitTemporaryFiles, clearTemporaryStage,
    cancelAttachmentSelection,
    mediaInfo,
    activateMedia,
    mediaDownloadAction,
    resolveMedia,
    listModes,
    async setMode(mode) {
      if (!['chat', 'work'].includes(mode)) { error(undefined, 'invalid_mode', 'Choose chat or work mode.'); return; }
      if (active) { error(undefined, 'busy', 'A request is already in progress.'); return; }
      if (await ensureMode(null, mode)) emit(modeReport());
    },
    async send({ id, prompt = '', attachmentCount = 0, temporary = false, mode, conversationId }) {
      // A message sent right after a pick must go out on that model, with the menu closed.
      while (modelOps) await modelQueue;
      if (mode != null && !['chat', 'work'].includes(mode)) { error(id, 'invalid_mode', 'Choose chat or work mode.'); return; }
      if (temporary && !temporaryReady()) { error(id, 'temporary_unavailable', 'Temporary chat could not be confirmed. Try again.'); return; }
      if (active) { error(id, 'busy', 'A request is already in progress.'); return; }
      if (attachmentCount > 0 && !detectLoggedIn()) {
        error(id, 'attachment_unavailable', 'Sign in to Gemini to attach files.');
        return;
      }
      if (cancelledAttachments) {
        const cleared = cancelledAttachments.hadControls && uploads === 0 && attachmentRemovers(cancelledAttachments.names).length === 0;
        if (cleared) cancelledAttachments = null;
        else { error(id, 'attachment_pending', 'Cancelled attachments may still be in Gemini. Clear them there or start a new chat before sending.'); return; }
      }
      const attachmentNames = [...document.querySelectorAll('input[type="file"]')].flatMap(input => [...(input.files || [])].map(file => file.name));
      let settle;
      const settled = new Promise(resolve => { settle = resolve; });
      const previousAssistants = assistantNodes(), previousUsers = userNodes();
      const job = active = {
        id,
        attachmentCount,
        attachmentNames,
        settled,
        settle,
        prompt: String(prompt || '').trim(),
        text: '',
        sentText: '',
        lastDelta: 0,
        work: mode === 'work',
        expectedConversation: conversationId,
        previousAssistants: new Set(previousAssistants),
        previousUsers: new Set(previousUsers)
      };
      if (typeof MutationObserver === 'function' && document.body) {
        job.observer = new MutationObserver(() => sampleDOM(job));
        job.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      }
      job.domTimer = setInterval(() => sampleDOM(job), 100);
      progress(job);
      try {
        let composer;
        for (let i = 0; i < 150 && active === job && !job.cancelled; i++) {
          const block = blocking();
          if (block) { fail(job, ...block); return; }
          composer = find('composer');
          if (composer) break;
          await sleep(100);
        }
        if (active !== job || job.cancelled) return;
        if (!composer) { fail(job, 'not_ready', 'Composer did not appear within 15 seconds.'); return; }
        if (mode != null && !await ensureMode(job, mode)) return;
        if (active !== job || job.cancelled) return;
        composer = find('composer');
        if (!composer) { fail(job, 'not_ready', 'Gemini composer changed. Please try again.'); return; }
        if (temporary && !temporaryReady()) { fail(job, 'temporary_unavailable', 'Temporary chat could not be confirmed. Try again.'); return; }
        dismissNudges();
        const fill = composer => {
          composer.focus?.();
          if (composer.tagName === 'TEXTAREA') {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(composer, prompt);
            composer.dispatchEvent?.(new Event('input', { bubbles: true }));
          } else {
            document.execCommand?.('selectAll', false);
            document.execCommand?.('insertText', false, prompt);
          }
        };
        const typed = node => String(node.tagName === 'TEXTAREA' ? node.value : node.innerText ?? node.textContent ?? '').trim();
        let uploadQuietAt = Date.now(), filledComposer = null, held = false;
        for (let i = 0; i < (attachmentCount > 0 ? 1200 : 100) && active === job && !job.started && !job.cancelled; i++) {
          if (temporary && !temporaryReady()) { fail(job, 'temporary_unavailable', 'Temporary chat could not be confirmed. Try again.'); return; }
          // Recheck the complete attachment batch until Send, then fill the current composer.
          if (attachmentCount > 0) {
            const pending = uploads > 0 || !!document.querySelector('input-container [role="progressbar"], input-area-v2 [role="progressbar"], mat-progress-spinner');
            const present = attachmentRemovers(job.attachmentNames, true).length >= attachmentCount;
            if (pending || !present) uploadQuietAt = Date.now();
            if (pending || !present || Date.now() - uploadQuietAt < 800) { await sleep(100); continue; }
          }
          composer = find('composer');
          if (!composer) { await sleep(100); continue; }
          if (composer !== filledComposer || (held && !typed(composer))) {
            fill(composer); filledComposer = composer; held = !!typed(composer);
          }
          if (temporary && !temporaryReady()) { fail(job, 'temporary_unavailable', 'Temporary chat could not be confirmed. Try again.'); return; }
          const button = find('send');
          if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
            job.startTimer = setTimeout(() => fail(job, 'send_failed', `No conversation request started within ${job.work ? 60 : 20} seconds.`), job.work ? 60000 : 20000);
            job.submitted = true;
            button.click();
            sampleDOM(job);
            confirmSend(job, composer).catch(() => {});
            return;
          }
          const block = blocking();
          if (block) { fail(job, ...block); return; }
          await sleep(100);
        }
        if (active === job && !job.started && !job.cancelled) {
          if (attachmentCount > 0) { fail(job, 'attachment_failed', 'Attachments did not become ready within two minutes. Check them in Gemini.'); return; }
          job.startTimer = setTimeout(() => fail(job, 'send_failed', `No conversation request started within ${job.work ? 60 : 20} seconds.`), job.work ? 60000 : 20000);
          if (temporary && !temporaryReady()) { fail(job, 'temporary_unavailable', 'Temporary chat could not be confirmed. Try again.'); return; }
          if (!composer) { fail(job, 'not_ready', 'Gemini composer changed. Please try again.'); return; }
          job.submitted = true;
          composer.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          sampleDOM(job);
        }
      } catch (e) { fail(job, 'send_failed', e.message); }
    },
    stop() {
      clearTemporaryStage();
      const job = active;
      if (!job) return Promise.resolve();
      // Whatever has rendered since the last sample belongs to the stopped reply.
      if (job.started) { try { sampleDOM(job); } catch (_) {} }
      if (active !== job) return Promise.resolve();
      job.cancelled = true;
      completeActivity(job);
      if (!job.started && job.attachmentCount > 0) {
        const controls = attachmentRemovers(job.attachmentNames);
        cancelledAttachments = { names: job.attachmentNames, hadControls: controls.length >= job.attachmentCount };
        controls.forEach(node => { try { node.click(); } catch (_) {} });
        if (!controls.length) {
          fail(job, 'attachment_cancelled', 'Stopped before sending. Clear the pending attachments in Gemini or start a new chat before sending again.');
          return job.settled;
        }
      }
      try { find('stop')?.click(); } catch (_) {}
      delta(job, true);
      job.finished = true;
      cancelTimers(job);
      active = null;
      if (job.media?.size) emit({ type: 'media', id: job.id, items: [...job.media.values()], final: true });
      if (!job.conversationId) job.conversationId = currentConversationId();
      emit({ type: 'done', id: job.id, text: job.text, conversationId: job.conversationId || null, rich: false });
      return job.settled;
    },
    async readConversation(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('invalid_id');
      const targetPath = '/app/' + id;
      if (!location.pathname.startsWith(targetPath)) {
        await window.__qchat.openConversation(id);
        if (!location.pathname.startsWith(targetPath)) {
          emit({ type: 'transcript', conversationId: id, messages: null, notOnPage: true });
          return;
        }
      }
      for (let i = 0, last = -1; i < 16; i++) {
        const count = conversationNodes().length;
        if (count && count === last) break;
        last = count;
        await sleep(300);
      }
      const scroller = (node => {
        for (; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle?.(node)?.overflowY || '')) return node;
        }
      })(conversationNodes()[0]);
      if (scroller) {
        const from = scroller.scrollTop;
        for (let i = 0, last = conversationNodes().length; i < 10; i++) {
          scroller.scrollTop = 0;
          await sleep(300);
          const count = conversationNodes().length;
          if (count === last) break;
          last = count;
        }
        if (!active) scroller.scrollTop = from;
      }
      const here = location.pathname.startsWith(targetPath);
      emit({ type: 'transcript', conversationId: id, messages: !active && here ? conversationMessages() : null });
    },
    async listConversations(offset = 0) {
      const start = Math.max(0, Math.floor(Number(offset)) || 0);
      loginCache = detectLoggedIn();
      if (!loginCache) {
        emit({ type: 'conversations', items: [], offset: start, total: 0 });
        return;
      }
      try {
        const nodes = [...document.querySelectorAll('a.conversation[href], .conversation a[href], [data-test-id="conversation"] a[href], a[href*="/app/"]')].filter(node => {
          const href = node.getAttribute('href') || node.href || '';
          return /\/app\/[A-Za-z0-9_-]{8,80}(?:[/?#]|$)/.test(href);
        });
        const seen = new Set();
        const all = [];
        for (const node of nodes) {
          const href = node.getAttribute('href') || node.href || '';
          const match = href.match(/\/app\/([A-Za-z0-9_-]{8,80})(?:[/?#]|$)/);
          if (!match) continue;
          const id = match[1];
          if (seen.has(id)) continue;
          seen.add(id);
          const titleNode = node.querySelector?.('.conversation-title') || node;
          const title = String(titleNode.innerText || titleNode.textContent || node.getAttribute('aria-label') || 'Untitled chat').trim().split('\n')[0].slice(0, 200);
          all.push({ id, title, updated: 0 });
        }
        const items = all.slice(start, start + 100);
        emit({ type: 'conversations', items, offset: start, total: all.length });
      } catch (e) {
        emit({ type: 'conversations', items: [], offset: start, total: 0, error: 'unavailable', reason: String(e?.message || '').slice(0, 80) });
      }
    },
    async openConversation(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('invalid_id');
      await window.__qchat.stop();
      media.clear();
      cancelledAttachments = null;
      downloadActivation = null;
      await status();
      if (!loginCache) return window.__qchat.newChat();
      const path = '/app/' + id;
      if (location.pathname === path) { await status(); return; }
      history.pushState?.({}, '', path);
      window.dispatchEvent?.(new PopStateEvent('popstate'));
      for (let i = 0; i < 15; i++) {
        await sleep(100);
        if (location.pathname === path && find('composer')) break;
      }
      if (location.pathname !== path || !find('composer')) {
        location.assign(path);
        return;
      }
      await sleep(200);
      await status();
    },
    listModels() {
      // Reads still waiting in line share one answer.
      if (!modelListing) modelListing = enqueueModelOp(() => { modelListing = null; return runModelMenu(); });
      return modelListing;
    },
    chooseModel(id) {
      // Only the newest pick matters: earlier ones still waiting are dropped.
      const choice = ++modelChoice;
      return enqueueModelOp(() => choice === modelChoice ? runModelMenu(id, choice) : undefined);
    },
    async newChat(options = {}) {
      currentSetupId = options.temporary ? options.setupId || null : null;
      clearTemporaryStage();
      await window.__qchat.stop();
      const composer = find('composer');
      const emptyTemporary = options.temporary && temporaryReady() && location.pathname === '/app' &&
        !assistantNodes().length && !userNodes().length && !(composer.value ?? composer.textContent).trim() &&
        !uploads && !cancelledAttachments && !attachmentRemovers([], true).length &&
        !document.querySelector('input-container [role="progressbar"], input-area-v2 [role="progressbar"], mat-progress-spinner') &&
        ![...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length);
      media.clear();
      downloadActivation = null;
      loginCache = detectLoggedIn();
      if (options?.temporary) {
        if (!loginCache) {
          emit({type:'error', code:'temporary_unavailable', message:'Sign in to Gemini to use temporary chats.', setupId:options.setupId || null});
          return;
        }
        if (temporaryReady()) {
          if (emptyTemporary) { await status(); return; }
          const fresh = find('fresh');
          if (!fresh || fresh.disabled || fresh.getAttribute('aria-disabled') === 'true') { emit({type:'error', code:'temporary_unavailable', message:'Could not start a fresh temporary chat in Gemini.', setupId:options.setupId || null}); return; }
          dispatchClickSequence(fresh, true);
          for (let i = 0; i < 15 && (location.pathname !== '/app' || assistantNodes().length || userNodes().length); i++) await sleep(100);
          if (location.pathname !== '/app' || assistantNodes().length || userNodes().length) { emit({type:'error', code:'temporary_unavailable', message:'Could not start a fresh temporary chat in Gemini.', setupId:options.setupId || null}); return; }
          cancelledAttachments = null;
          if (temporaryReady()) { await status(); return; }
        }
        const tempBtn = [...document.querySelectorAll('button, a, [role="button"], gem-nav-list-item')].find(node =>
          shown(node) && /temp(?:orary)? chat/i.test(`${node.innerText || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-test-id') || ''}`));
        if (!tempBtn || tempBtn.disabled || tempBtn.getAttribute('aria-disabled') === 'true') {
          emit({type:'error', code:'temporary_unavailable', message:'Temporary chat is unavailable in Gemini.', setupId:options.setupId || null});
          return;
        }
        dispatchClickSequence(tempBtn, true);
        await sleep(300);
        await status();
        return;
      }
      cancelledAttachments = null;
      const hadTurns = assistantNodes().length > 0 || userNodes().length > 0 || location.pathname !== '/app';
      const button = find('fresh');
      if (button) dispatchClickSequence(button);
      for (let i = 0; i < 8; i++) {
        await sleep(100);
        if (location.pathname === '/app' && assistantNodes().length === 0 && userNodes().length === 0) break;
      }
      if (hadTurns && (location.pathname !== '/app' || assistantNodes().length > 0 || userNodes().length > 0)) {
        location.assign('https://gemini.google.com/app');
        return;
      }
      await status();
    },
    status
  };

  let lastURL = location.href, hadComposer = false, lastTemporary = false, lastBlock = '', lastModel;
  setInterval(() => {
    const ready = !!find('composer');
    // The mode switcher renders after the composer, so the first status often has no model.
    // Report it as soon as it shows up or changes, or the app's picker reads "Model" for a minute.
    const model = modelShort();
    const changedModel = model !== undefined && model !== lastModel;
    if (model !== undefined) lastModel = model;
    const currentTemporary = temporaryReady();
    const changedTemporary = currentTemporary !== lastTemporary;
    lastTemporary = currentTemporary;
    const changedURL = lastURL !== location.href;
    if (changedURL) lastURL = location.href;
    if (hadComposer !== ready || changedURL || changedTemporary || changedModel || loginDue()) status();
    hadComposer = ready;
    const block = blocking();
    if (block && block[1] !== lastBlock) {
      lastBlock = block[1];
      if (active) fail(active, ...block);
      else error(undefined, ...block);
      status();
    }
    if (!block) lastBlock = '';
  }, 500);

  status();
})();
