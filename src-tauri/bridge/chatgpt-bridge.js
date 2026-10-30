// Drive the real composer and observe a clone of its fetch stream; never call the chat API.
(() => {
  if (!/(^|\.)chatgpt\.com$/.test(location.hostname) || window.top !== window || window.__qchat) return;
  const selectors = {
    composer: ['#prompt-textarea', '#mobile-composer-prompt', 'textarea[name="prompt-textarea"]', '[contenteditable="true"][id*="prompt"]', 'form .ProseMirror[contenteditable="true"][role="textbox"]'],
    send: ['[data-testid="send-button"]', 'button[aria-label*="Send"]'],
    stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    assistant: ['[data-message-author-role="assistant"]', '[data-message-role="assistant"]:not([data-conversation-recovery])', '[data-turn="assistant"]'],
    body: ['[data-assistant-markdown-root]', '.markdown', '[data-message-content]'],
    fresh: ['[data-testid="create-new-chat-button"]', 'button[aria-label="New chat"]', 'a[href="/"]']
  };
  const find = key => key === 'composer'
    ? selectors.composer.flatMap(s => [...document.querySelectorAll(s)]).find(node => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'))
    : selectors[key].map(s => document.querySelector(s)).find(Boolean);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const queue = [];
  function flush() {
    if (typeof window.__QCHAT_EMIT__ !== 'function') return;
    while (queue.length) { try { window.__QCHAT_EMIT__(queue.shift()); } catch (_) {} }
  }
  function emit(event) { queue.push(event); flush(); }
  setInterval(flush, 100);
  const debug = (...args) => { if (window.__QCHAT_DEBUG__) console.debug('[qchat]', ...args); };
  let active, loginCache, loginAt = -Infinity, loginProbe, loginUnknown = true, loginStale = false;
  function error(id, code, message) { emit({ type: 'error', ...(id == null ? {} : { id }), code, message }); }
  function cancelTimers(job) { clearTimeout(job.watchdog); clearTimeout(job.startTimer); clearTimeout(job.deltaTimer); clearInterval(job.domTimer); job.observer?.disconnect(); }
  function fail(job, code, message) {
    if (active !== job || job.finished) return;
    job.finished = true; cancelTimers(job); active = null;
    if (job.reader) job.reader.cancel().catch(() => {});
    error(job.id, code, message);
  }
  function progress(job) {
    clearTimeout(job.watchdog);
    job.watchdog = setTimeout(() => fail(job, 'timeout', 'No stream progress for five minutes.'), 300000);
  }
  function delta(job, final = false) {
    clearTimeout(job.deltaTimer);
    const delay = 50 - (Date.now() - job.lastDelta);
    if (delay > 0) {
      job.deltaTimer = setTimeout(() => delta(job, final), delay); return;
    }
    if (job.text !== job.sentText && (job.text || final)) {
      emit({ type: 'delta', id: job.id, text: job.text });
      job.sentText = job.text; job.lastDelta = Date.now();
    }
  }
  async function finish(job, fallback = true) {
    if (active !== job || job.finished || job.finishing) return;
    job.finishing = true;
    if (fallback) sampleDOM(job);
    if (active !== job || job.finished) return;
    // Keep the final delta within the same 20 Hz limit before emitting done.
    await sleep(Math.max(0, 50 - (Date.now() - job.lastDelta)));
    if (active !== job || job.finished) return;
    delta(job, true); job.finished = true; cancelTimers(job); active = null;
    emit({ type: 'done', id: job.id, text: job.text, conversationId: job.conversationId || null });
  }
  function assistantNodes() {
    return [...document.querySelectorAll(selectors.assistant.join(','))];
  }
  function sampleDOM(job) {
    if (active !== job || job.finished) return;
    const nodes = assistantNodes().filter(node => !job.previousAssistants.has(node));
    const node = nodes[nodes.length - 1];
    const body = node && (selectors.body.map(s => node.querySelector(s)).find(Boolean) || node);
    const text = body?.innerText?.trim() || '';
    if (text && text !== job.domText) {
      job.domText = text; job.stableAt = Date.now(); progress(job);
      if (!job.netText) { job.text = text; delta(job); }
    }
    if (!job.conversationId) job.conversationId = location.pathname.match(/^\/(?:c|uc)\/([^/]+)/)?.[1];
    if (find('stop')) job.sawStop = true;
    if (!job.stream && job.domText && !find('stop') &&
        (job.sawStop || find('send')) && Date.now() - job.stableAt >= 800) finish(job);
  }
  function networkText(job, text) {
    job.netText = text;
    job.text = text || job.domText || '';
    delta(job);
  }
  function applyNDJSON(job, packet) {
    if (packet.detail?.conversationId) job.conversationId = packet.detail.conversationId;
    if (packet.type === 'content') {
      const messages = job.contents ||= new Map();
      const prior = messages.get(packet.messageId);
      if (prior && packet.revision <= prior.revision) return;
      if (packet.mode === 'append' && prior && packet.baseRevision !== prior.revision) {
        debug('Revision gap', packet.baseRevision, prior.revision); return;
      }
      const markdown = packet.mode === 'append' ? (prior?.markdown || '') + (packet.markdown || '') : (packet.markdown || '');
      // DIL fallbackMarkdown is a complete snapshot even on append packets.
      const fallback = packet.dil?.fallbackMarkdown ?? (packet.mode === 'append' ? prior?.fallback : '');
      const text = markdown || fallback || '';
      messages.set(packet.messageId, { revision: packet.revision, markdown, fallback, text });
      networkText(job, [...messages.values()].map(m => m.text).join('\n\n'));
    } else if (packet.type === 'shared' && !job.netText && packet.html) {
      const template = document.createElement('template'); template.innerHTML = packet.html;
      // Only assistant content, never controls, sidebar, or hidden templates.
      const body = template.content.querySelector(selectors.body.join(','));
      if (body?.textContent?.trim()) networkText(job, body.textContent.trim());
    }
  }
  function visible(message) {
    return message && message.author && message.author.role === 'assistant' &&
      (!message.channel || message.channel === 'final') &&
      !message.metadata?.is_visually_hidden_from_conversation &&
      ['text', 'multimodal_text'].includes(message.content?.content_type);
  }
  function apply(job, packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.conversation_id) job.conversationId = packet.conversation_id;
    if (packet.o === 'patch' && Array.isArray(packet.v)) { packet.v.forEach(op => apply(job, op)); return; }
    if (!Object.prototype.hasOwnProperty.call(packet, 'v')) return;
    if (packet.p !== undefined) job.path = packet.p;
    if (packet.o !== undefined) job.operation = packet.o;
    const path = packet.p === undefined ? job.path : packet.p;
    const operation = packet.o === undefined ? job.operation : packet.o;
    const value = packet.v;
    if (value && typeof value === 'object' && value.message) {
      job.message = value.message;
      if (value.conversation_id) job.conversationId = value.conversation_id;
    } else if (path && job.message) {
      const keys = path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      let target = { message: job.message };
      for (let i = 0; i < keys.length - 1; i++) {
        target = target[keys[i]];
        if (!target || typeof target !== 'object') return;
      }
      const key = keys[keys.length - 1];
      if (operation === 'append') {
        if (typeof target[key] === 'string') target[key] += value;
        else if (Array.isArray(target[key])) target[key].push(...(Array.isArray(value) ? value : [value]));
      } else if (operation === 'remove') delete target[key];
      else target[key] = value;
    }
    if (visible(job.message)) {
      const text = (job.message.content.parts || []).filter(p => typeof p === 'string').join('');
      if (text !== job.netText) networkText(job, text);
    }
  }
  async function observe(response, job) {
    try {
      if (!response.ok) {
        const body = await response.text(); let message = body;
        try { const data = JSON.parse(body); message = typeof data.detail === 'string' ? data.detail : data.detail?.message || data.message || body; } catch (_) {}
        fail(job, [401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limited' : 'stream_failed', message.slice(0, 1000)); return;
      }
      job.reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      let format = /event-stream/i.test(response.headers.get('content-type') || '') ? 'sse' : null;
      let data = [];
      const line = raw => {
        raw = raw.replace(/\r$/, '');
        if (!format && raw.trim()) format = /^(data:|event:|:)/.test(raw) ? 'sse' : 'ndjson';
        if (format === 'ndjson') {
          if (raw.trim()) { try { applyNDJSON(job, JSON.parse(raw)); } catch (e) { debug('NDJSON', e.message); } }
        } else if (raw.startsWith('data:')) data.push(raw.slice(5).trimStart());
        else if (!raw.trim() && data.length) {
          const value = data.join('\n'); data = [];
          if (value === '[DONE]') return true;
          try { apply(job, JSON.parse(value)); } catch (e) { debug('SSE', e.message); }
        }
      };
      let ended = false;
      while (active === job && !job.finished && !ended) {
        const { value, done } = await job.reader.read();
        progress(job); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          if (line(raw)) { ended = true; break; }
        }
        if (done) { if (buffer.trim()) line(buffer); line(''); break; }
      }
      if (ended) await job.reader.cancel();
      if (job.netText) await finish(job);
      else { job.stream = false; sampleDOM(job); }
    } catch (e) { if (!job.finished && !job.finishing) fail(job, 'stream_failed', e.message); }
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let job;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = (init?.method || input?.method || 'GET').toUpperCase();
      // Prepare can prefetch while typing, before React enables the real Send button.
      if (method === 'POST' && /\/(?:backend-(?:api|anon)|unauth-mweb)\/(?:f\/)?conversation(?:\/updates)?\/?$/.test(url.pathname) && active) {
        const current = active;
        if (!current.started) {
          current.started = true; clearTimeout(current.startTimer); progress(current);
          emit({ type: 'start', id: current.id });
        }
        if (!window.__QCHAT_DISABLE_NET__ && !current.stream) {
          job = current; job.stream = true;
        }
      }
    } catch (_) {}
    const request = originalFetch.apply(this, arguments);
    if (job) request.then(response => { try { observe(response.clone(), job); } catch (e) { fail(job, 'stream_failed', e.message); } }, e => fail(job, 'stream_failed', e.message));
    return request;
  };
  function blocking() {
    const excluded = '[data-message-author-role], [data-message-role], [data-turn], article, nav';
    const real = node => !node.closest(excluded);
    const challenge = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], #challenge-form, [id^="cf-"], [class^="cf-"]')].some(real);
    if (/Just a moment|Verify you are human|Checking your browser/i.test(document.title) || challenge) return ['not_ready', 'Cloudflare challenge is blocking chat.'];
    const composer = find('composer');
    const area = composer?.closest('form') || composer?.parentElement?.parentElement;
    const walls = [...document.querySelectorAll('[role="dialog"], [role="alert"]')];
    if (area) walls.push(...area.querySelectorAll('[data-testid*="banner"], [class*="banner"]'));
    for (const wall of walls.filter(real)) {
      const copy = wall.cloneNode(true);
      copy.querySelectorAll(excluded).forEach(n => n.remove());
      const text = copy.textContent || '';
      if (/You've reached our limit|You’ve reached our limit|reached your.*limit/i.test(text)) return ['rate_limited', 'Guest chat limit reached.'];
      const stay = [...wall.querySelectorAll('button')].find(b => /stay logged out/i.test(b.textContent));
      if (stay) { stay.click(); continue; }
      if (/log in|sign up/i.test(text) && !composer) return ['auth', 'Login dialog is blocking chat.'];
    }
  }

  function loginInterval() {
    if (loginUnknown || loginStale || !find('composer') || /^\/(?:auth|login|signin)(?:\/|$)/.test(location.pathname)) return 5000;
    if (document.visibilityState === 'hidden' || !document.hasFocus()) return 60000;
    return loginCache ? 60000 : 30000;
  }
  function loginDue() { return Date.now() - loginAt >= loginInterval(); }
  async function status() {
    if (!loginProbe && loginDue()) {
      loginProbe = (async () => {
        const controller = new AbortController();
        const probeURL = location.href;
        let timer;
        try {
          const session = await Promise.race([
            originalFetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(response => {
              if (!response.ok) throw new Error('Session unavailable');
              return response.json();
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error('Session timeout')); }, 8000);
            })
          ]);
          if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Invalid session');
          loginCache = !!(session.user || session.accessToken);
          loginUnknown = false; loginStale = location.href !== probeURL;
        } catch (_) {
          // An unavailable session is unknown, not evidence that a known login ended.
          loginUnknown = true;
        } finally {
          clearTimeout(timer); loginAt = Date.now();
        }
      })();
    }
    const probe = loginProbe;
    if (probe) { await probe; if (loginProbe === probe) loginProbe = null; }
    emit({ type: 'status', ready: !!find('composer'), loggedIn: !!loginCache, authPending: loginUnknown, url: location.href });
  }
  window.__qchat = {
    async send({ id, prompt }) {
      if (active) { error(id, 'busy', 'A request is already in progress.'); return; }
      const job = active = { id, text: '', sentText: '', lastDelta: 0, previousAssistants: new Set(assistantNodes()) };
      job.observer = new MutationObserver(() => sampleDOM(job));
      job.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      job.domTimer = setInterval(() => sampleDOM(job), 100);
      progress(job);
      try {
        let composer;
        for (let i = 0; i < 150 && active === job; i++) {
          const block = blocking(); if (block) { fail(job, ...block); return; }
          composer = find('composer'); if (composer) break; await sleep(100);
        }
        if (active !== job) return;
        if (!composer) { fail(job, 'not_ready', 'Composer did not appear within 15 seconds.'); return; }
        composer.focus();
        if (composer.tagName === 'TEXTAREA') {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, prompt);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll', false); document.execCommand('insertText', false, prompt);
        }
        job.startTimer = setTimeout(() => fail(job, 'send_failed', 'No conversation request started within 20 seconds.'), 20000);
        for (let i = 0; i < 100 && active === job && !job.started; i++) {
          const button = find('send');
          if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') { button.click(); return; }
          const block = blocking(); if (block) { fail(job, ...block); return; }
          await sleep(100);
        }
        if (active === job && !job.started) composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      } catch (e) { fail(job, 'send_failed', e.message); }
    },
    stop() {
      const job = active; if (!job) return;
      find('stop')?.click();
      if (job.reader) job.reader.cancel().catch(() => {});
      finish(job, false);
    },
    async newChat() {
      if (active) { error(active.id, 'busy', 'Stop the active request before starting a new chat.'); return; }
      const button = find('fresh');
      if (button) button.click();
      else { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }
      await sleep(300); await status();
    },
    status
  };
  let lastURL = location.href, hadComposer = false, lastBlock = '';
  setInterval(() => {
    const ready = !!find('composer');
    const changedURL = lastURL !== location.href;
    if (changedURL) { loginStale = true; lastURL = location.href; }
    if (hadComposer !== ready || changedURL || (!loginProbe && loginDue())) status();
    hadComposer = ready;
    const block = blocking();
    if (block && block[1] !== lastBlock) { lastBlock = block[1]; error(active?.id, ...block); status(); }
    if (!block) lastBlock = '';
  }, 500);
})();




