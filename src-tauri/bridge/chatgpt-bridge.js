// Drive the real composer and observe a clone of its fetch stream; never call the chat API.
(() => {
  if (!/(^|\.)chatgpt\.com$/.test(location.hostname) || window.top !== window || window.__qchat) return;
  const selectors = {
    composer: ['#prompt-textarea', '#mobile-composer-prompt', 'textarea[name="prompt-textarea"]', '[contenteditable="true"][id*="prompt"]', 'form .ProseMirror[contenteditable="true"][role="textbox"]'],
    send: ['[data-testid="send-button"]', 'button[aria-label*="Send"]'],
    stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    assistant: ['[data-message-author-role="assistant"]', '[data-message-role="assistant"]:not([data-conversation-recovery])', '[data-turn="assistant"]', '[data-dil-source-message-id][data-markdown-copy]', '[data-chatgpt-search-message-ids]'],
    body: ['[data-assistant-markdown-root]', '.markdown', '[data-message-content]', '[data-dil-message-id]'],
    fresh: ['[data-testid="create-new-chat-button"]', 'button[aria-label="New chat"]', 'a[href="/"]']
  };
  const find = key => key === 'composer'
    ? selectors.composer.flatMap(s => [...document.querySelectorAll(s)]).find(node => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'))
    : selectors[key].map(s => document.querySelector(s)).find(Boolean);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const queue = [];
  function wellFormed(text) {
    // JSON permits escaped lone surrogates; native UTF-8 strings do not. Keep the
    // accumulated site text intact and repair only the transport snapshot.
    return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, part => part.length === 2 ? part : '\uFFFD');
  }
  function transportValue(value) {
    if (typeof value === 'string') return wellFormed(value);
    if (Array.isArray(value)) return value.map(transportValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transportValue(item)]));
    return value;
  }
  function deliveryFailed(event) {
    // A later cumulative snapshot can resync a failed delta. Never reject the
    // website's fetch promise or create a global unhandled rejection.
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
  const debug = (...args) => { if (window.__QCHAT_DEBUG__) console.debug('[qchat]', ...args); };
  let active, loginCache, loginAt = -Infinity, loginProbe, loginUnknown = true, loginStale = false;
  const media = new Map();
  let mediaSerial = 0, inputSerial = 0, uploads = 0, uploadFailureAt = -Infinity, attachmentSelectionAt = -Infinity, cancelledAttachments, downloadActivation;
  function error(id, code, message) { emit({ type: 'error', ...(id == null ? {} : { id }), code, message }); }
  function toolActivity(recipient) {
    if (typeof recipient !== 'string' || !recipient || ['all', 'all_tools'].includes(recipient)) return null;
    if (/^(?:web|browser)(?:[._]|$)/i.test(recipient)) return /(?:open|browse|read|click|find|screenshot)/i.test(recipient)
      ? { kind: 'browse', label: 'Reading sources' } : { kind: 'search', label: 'Searching the web' };
    if (/^(?:python|code_interpreter|computer\.terminal|functions\.(?:exec|run))(?:[._]|$)/i.test(recipient)) return { kind: 'code', label: 'Running code' };
    return { kind: 'tool', label: 'Using a tool' };
  }
  function completeActivity(job) {
    if (!job.activity) return;
    if (job.activityKey?.startsWith('message:')) (job.completedActivities ||= new Set()).add(job.activityKey);
    emit({ type: 'activity', id: job.id, ...job.activity, state: 'complete' });
    job.activity = null;
  }
  function startActivity(job, activity, key) {
    if (active !== job || job.finished || job.cancelled || job.completedActivities?.has(key)) return;
    if (job.activityKey === key && job.activity) return;
    if (job.activity) completeActivity(job);
    job.activityKey = key; job.activity = activity;
    emit({ type: 'activity', id: job.id, ...activity, state: 'running' });
  }
  function messageActivity(job, message) {
    if (!message || job.previousAssistantIds.has(message.id)) return;
    const role = message.author?.role;
    if (role === 'assistant') {
      const activity = toolActivity(message.recipient);
      if (activity) startActivity(job, activity, `message:${message.id || message.recipient}`);
    } else if (role === 'tool' && job.activity && (!message.author.name || toolActivity(message.author.name)?.kind === job.activity.kind)) {
      (job.completedActivities ||= new Set()).add(job.activityKey);
      completeActivity(job);
    }
  }
  function cancelTimers(job) { clearTimeout(job.watchdog); clearTimeout(job.startTimer); clearTimeout(job.deltaTimer); clearInterval(job.domTimer); job.observer?.disconnect(); job.settle?.(); }
  function disposeReader(job) {
    if (!job.reader || job.readerDisposed) return;
    job.readerDisposed = true;
    // This is only the observer's tee branch. Never await its cancellation,
    // which can remain pending until the site's primary branch also finishes.
    try { Promise.resolve(job.reader.cancel()).catch(() => {}); } catch (_) {}
  }
  async function fail(job, code, message) {
    if (active !== job || job.finished || job.failing) return;
    job.failing = true;
    if (!job.started && job.attachmentCount > 0 && !job.cancelled) {
      job.cancelled = true;
      if (!await clearFailedAttachments(job)) {
        code = 'attachment_pending';
        message = 'Pending attachments could not be cleared. Remove them in ChatGPT or start a new chat before sending again.';
      }
      if (active !== job || job.finished) return;
    }
    job.text = citationText(job, job.text);
    if (job.text !== job.sentText) { emit({ type: 'delta', id: job.id, text: job.text }); job.sentText = job.text; }
    completeActivity(job);
    job.finished = true; cancelTimers(job); active = null;
    disposeReader(job);
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
    job.watchdog = setTimeout(() => fail(job, 'timeout', 'No stream progress for five minutes.'), 300000);
  }
  function delta(job, final = false) {
    clearTimeout(job.deltaTimer);
    const delay = 50 - (Date.now() - job.lastDelta);
    if (delay > 0) {
      job.deltaTimer = setTimeout(() => delta(job, final), delay); return;
    }
    const text = wellFormed(citationText(job, final ? job.text : job.text.replace(/[\uD800-\uDBFF]$/, '')));
    if (text !== job.sentText && (text || final)) {
      emit({ type: 'delta', id: job.id, text });
      job.sentText = text; job.lastDelta = Date.now();
    }
  }
  async function finish(job, fallback = true) {
    if (active !== job || job.finished || job.finishing) return;
    job.finishing = true;
    if (fallback) {
      sampleDOM(job);
      // A terminal observer packet is not permission to truncate a site turn
      // that still visibly generates. Resume DOM observation until it settles.
      if (!job.cancelled && (find('stop') || job.imageGenerating)) {
        job.finishing = false; job.stream = false; job.streamEnded = true; job.detached = true; disposeReader(job); return;
      }
      // DIL rendering can continue after the transport's terminal packet. Let
      // the current visible reply settle before choosing its final snapshot.
      job.finishDOMAt ??= Date.now();
      while (active === job && !job.finished && !job.cancelled &&
             job.assistantNode?.hasAttribute('data-dil-source-message-id') &&
             Date.now() - (job.stableAt ?? job.finishDOMAt) < 800) {
        await sleep(100); sampleDOM(job);
        if (!job.cancelled && (find('stop') || job.imageGenerating)) {
          job.finishing = false; job.stream = false; job.streamEnded = true; job.detached = true; disposeReader(job); return;
        }
      }
    }
    if (active !== job || job.finished) return;
    // Keep the final delta within the same 20 Hz limit before emitting done.
    await sleep(Math.max(0, 50 - (Date.now() - job.lastDelta)));
    if (active !== job || job.finished) return;
    if (fallback && !job.cancelled && (find('stop') || job.imageGenerating)) {
      job.finishing = false; job.stream = false; job.streamEnded = true; job.detached = true; disposeReader(job); return;
    }
    if (job.sawImageGeneration && /^(?:(?:Loading images?|Creating image|Generating image|Image created|Edit)(?:[.\u2026\s]|\d{1,3}\s*%)*)+$/i.test(job.text.trim())) job.text = '';
    job.text = citationText(job, job.text);
    completeActivity(job);
    delta(job, true); job.finished = true; cancelTimers(job); active = null;
    disposeReader(job);
    if (job.media?.size) emit({ type: 'media', id: job.id, items: [...job.media.values()], final: true });
    emit({ type: 'done', id: job.id, text: job.text, conversationId: job.conversationId || null, rich: !!job.rich });
  }
  function assistantNodes() {
    const excluded = '[data-user-message-bubble], [data-message-author-role="user"], [data-message-channel="analysis"], [data-channel="analysis"], [data-thinking], [data-testid*="thinking"], [hidden], [aria-hidden="true"]';
    return [...document.querySelectorAll(selectors.assistant.join(','))].filter(node =>
      !node.closest(excluded) && !node.querySelector('[data-user-message-bubble]'));
  }
  const userSelector = '[data-message-author-role="user"], [data-message-role="user"], [data-turn="user"], [data-user-message-bubble]';
  function messageIds(node) {
    const owner = node.closest('[data-message-id], [data-dil-source-message-id], [data-dil-message-id], [data-chatgpt-search-message-ids]');
    return [...new Set([node, owner, node.querySelector('[data-dil-message-id]')].filter(Boolean).flatMap(item =>
      ['data-message-id', 'data-dil-source-message-id', 'data-dil-message-id', 'data-chatgpt-search-message-ids']
        .flatMap(key => (item.getAttribute(key) || '').split(/[\s,]+/).filter(Boolean))))];
  }
  function currentAssistants(job) {
    if (!job.submitted) return [];
    const users = [...document.querySelectorAll(userSelector)];
    const latest = users[users.length - 1];
    const ids = latest ? messageIds(latest) : [];
    const boundary = latest && (job.userMessageIds?.size
      ? ids.some(id => job.userMessageIds.has(id))
      : !job.previousUsers.has(latest) && !ids.some(id => job.previousUserIds.has(id)) &&
        (latest.innerText || latest.textContent || '').trim() === job.prompt);
    return assistantNodes().filter(node => {
      const ids = messageIds(node);
      // Node identity alone is unsafe: restored history can hydrate or remount
      // after Send. Accept only stream-correlated messages or this user turn.
      if (job.previousAssistants.has(node) || ids.some(id => job.previousAssistantIds.has(id))) return false;
      if (job.scopedAssistants.has(node) || ids.some(id => job.responseIds.has(id))) return true;
      const order = boundary ? latest.compareDocumentPosition?.(node) || 0 : 0;
      if (!(order & 4) || order & 1) return false;
      job.scopedAssistants.add(node);
      ids.forEach(id => job.responseIds.add(id));
      return true;
    });
  }
  // The conversation as the site rendered it, so History can show what the app never saw.
  function conversationNodes() {
    const nodes = [...assistantNodes(), ...[...document.querySelectorAll(userSelector)].filter(node => !node.closest('[hidden], [aria-hidden="true"]'))];
    return nodes.filter(node => !nodes.some(other => other !== node && node.contains(other)))
      .sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }
  function nodeMarkdown(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || node.matches('button, svg, style, script, img, video, audio, [hidden], [aria-hidden="true"], .sr-only')) return '';
    const inner = (from = node) => [...from.childNodes].map(nodeMarkdown).join('');
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(+tag[1])} ${inner().trim()}\n\n`;
    if (tag === 'p') return `${inner().trim()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '---\n\n';
    if (tag === 'strong' || tag === 'b') return `**${inner()}**`;
    if (tag === 'em' || tag === 'i') return `*${inner()}*`;
    if (tag === 'code') return `\`${node.textContent}\``;
    if (tag === 'pre') {
      const code = node.querySelector('code');
      const language = code?.className.match(/language-([\w+#.-]+)/)?.[1] || '';
      return `\`\`\`${language}\n${(code || node).textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    }
    if (tag === 'a') return /^https:/.test(node.href) ? `[${inner()}](${node.href})` : inner();
    if (tag === 'blockquote') return `${inner().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.children].filter(item => item.tagName === 'LI').map((item, index) => {
        const marker = tag === 'ol' ? `${index + 1}. ` : '- ';
        return marker + inner(item).trim().replace(/\n+/g, '\n').split('\n').join(`\n${' '.repeat(marker.length)}`);
      });
      return `${items.join('\n')}\n\n`;
    }
    if (tag === 'table') {
      const rows = [...node.rows].map(row => `| ${[...row.cells].map(cell => inner(cell).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')).join(' | ')} |`);
      if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat(node.rows[0].cells.length)}`);
      return `${rows.join('\n')}\n\n`;
    }
    return inner();
  }
  function conversationMessages() {
    return conversationNodes().map(node => {
      const role = node.matches(userSelector) ? 'user' : 'assistant';
      const body = role === 'assistant' ? node.querySelector(selectors.body.join(',')) || node : node;
      const text = role === 'user' ? (body.innerText || body.textContent || '').trim() : nodeMarkdown(body).trim();
      return { role, text, hasMedia: !!node.querySelector('img, video, audio') };
    }).filter(item => item.text || item.hasMedia);
  }
  async function sessionToken() {
    const response = await originalFetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    const token = response.ok ? (await response.json())?.accessToken : null;
    if (typeof token !== 'string' || !token) throw new Error('No session');
    return token;
  }
  // Just after the page reports ready its session can still be settling, so a miss here is not final.
  async function settled(read) {
    for (let attempt = 0; ; attempt++) {
      try { return await read(await sessionToken()); }
      catch (error) { if (attempt === 3) throw error; await sleep(1000 + attempt * 1000); }
    }
  }
  async function readJSON(url, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await originalFetch(url, { credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  // The visible branch only: walks up from the current node, then drops tool calls,
  // hidden system context and reasoning. Consecutive assistant parts form one reply.
  // Rich replies are stored as a layout language. The text says where each image goes, by search
  // query, and the message's component results hold the image for each query.
  function webImageToken(image, caption) {
    const url = image?.thumbnail_url || image?.content_url;
    try { if (new URL(url).hostname !== 'images.openai.com') return ''; } catch (_) { return ''; }
    // Result titles are the source page's headline, so only the reply's own caption is shown.
    const label = String(caption || 'Image').replace(/[\[\]()\n]/g, ' ').trim().slice(0, 120);
    return `![${label}](qchat-web:${btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')})`;
  }
  function layoutToMarkdown(text, message) {
    // Preserve executable-looking DIL as data for the UI's bounded interpreter.
    if (window.QResponseTags.hasInteractive(text)) return String(text).trim();
    const results = message?.metadata?.model_dil_v2?.appData?.opGenui?.componentResults || {};
    const byQuery = new Map();
    for (const result of Object.values(results)) {
      for (const image of Array.isArray(result?.state?.images) ? result.state.images : []) {
        if (image?.image_search_query && !byQuery.has(image.image_search_query)) byQuery.set(image.image_search_query, image);
      }
    }
    return window.QResponseTags.toMarkdown(text, { image: (query, caption) => webImageToken(byQuery.get(query), caption) }).trim();
  }
  function storedSources(message) {
    const out = [];
    for (const group of Array.isArray(message?.metadata?.search_result_groups) ? message.metadata.search_result_groups : []) {
      for (const entry of Array.isArray(group?.entries) ? group.entries : []) {
        const ref = entry?.ref_id;
        if (!entry?.url || !ref || !Number.isInteger(ref.turn_index)) continue;
        out.push({ id: `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`, url: entry.url, title: String(entry.title || entry.attribution || entry.url).slice(0, 300) });
      }
    }
    return out;
  }
  function storedMedia(parts, attachments) {
    const seen = new Set(), out = [];
    const add = (file, kind, name, mime) => {
      if (typeof file !== 'string' || !/^[A-Za-z0-9_-]{4,120}$/.test(file) || seen.has(file)) return;
      seen.add(file);
      out.push({ file, kind, name: String(name || (kind === 'image' ? 'Image' : 'Attachment')).slice(0, 200), ...(typeof mime === 'string' ? { mime: mime.slice(0, 100) } : {}) });
    };
    for (const part of parts) {
      if (part && typeof part === 'object' && typeof part.asset_pointer === 'string') add(part.asset_pointer.split('://').pop(), /image/.test(part.content_type || '') ? 'image' : 'file', part.name, part.mime_type);
    }
    for (const item of attachments) add(item?.id, /^image\//.test(item?.mime_type || '') ? 'image' : 'file', item?.name, item?.mime_type);
    return out;
  }
  function messagesFromMapping(data) {
    const chain = [];
    const seen = new Set();
    for (let id = data?.current_node; id && data.mapping?.[id] && !seen.has(id); id = data.mapping[id].parent) { seen.add(id); chain.unshift(data.mapping[id]); }
    const out = [];
    let generated = [];
    for (const node of chain) {
      const message = node.message;
      const role = message?.author?.role;
      if (message?.metadata?.is_visually_hidden_from_conversation) continue;
      // Generated images are stored on the tool's message; they belong to the next reply.
      if (role === 'tool') { generated.push(...storedMedia(Array.isArray(message.content?.parts) ? message.content.parts : [], []).map(file => ({ ...file, before: true }))); continue; }
      if (role !== 'user' && role !== 'assistant') continue;
      if (role === 'assistant' && message.recipient && message.recipient !== 'all') continue;
      // The site folds these away too: "I'll look that up" notes between tool calls.
      if (role === 'assistant' && ((message.channel && message.channel !== 'final') || message.metadata?.is_thinking_preamble_message)) continue;
      const content = message.content;
      if (!content || !['text', 'multimodal_text'].includes(content.content_type)) continue;
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const raw = parts.filter(part => typeof part === 'string').join('\n');
      const converted = role === 'assistant' ? layoutToMarkdown(raw, message) : raw;
      const text = converted.replace(/\uE200(?!cite\uE202)[^\uE201]*\uE201/g, '').replace(/[\uE203-\uE206]/g, '').trim();
      const files = storedMedia(parts, Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : []);
      // Uploads and generated images come before the words that follow them.
      files.forEach(file => { file.before = true; });
      if (role === 'assistant') { files.unshift(...generated); generated = []; }
      if (!text && !files.length) continue;
      const sources = role === 'assistant' ? storedSources(message).filter(source => text.includes(source.id)) : [];
      const last = out[out.length - 1];
      if (role === 'assistant' && last?.role === 'assistant') { last.text = [last.text, text].filter(Boolean).join('\n\n'); last.media.push(...files); last.hasMedia = last.media.length > 0; last.sources.push(...sources); continue; }
      out.push({ role, text, media: files, hasMedia: files.length > 0, sources });
    }
    // An image can be the last thing in a conversation, with no reply text after it.
    if (generated.length) out.push({ role: 'assistant', text: '', media: generated, hasMedia: true, sources: [] });
    return out;
  }
  async function storedMessages(id) {
    const data = await settled(token => readJSON(`/backend-api/conversation/${id}`, token));
    const messages = messagesFromMapping(data);
    return messages.length ? messages : null;
  }
  function safeURL(raw) {
    if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) return null;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\r\n]+$/i.test(raw)) return raw;
    if (!/^(?:https:|blob:|\/(?!\/))/i.test(raw)) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === 'blob:' && url.origin === new URL(location.href).origin) return url.href;
      if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
          (/(^|\.)(?:chatgpt\.com|openai\.com|oaiusercontent\.com|oaistatic\.com)$/.test(url.hostname) || /\.blob\.core\.windows\.net$/.test(url.hostname))) return url.href;
    } catch (_) {}
    return null;
  }
  function mediaKind(name = '', mime = '') {
    if (/^(image\/(?!svg)|audio\/|video\/)/i.test(mime)) return mime.split('/')[0];
    if (/\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(name)) return 'image';
    if (/\.(mp3|wav|ogg|m4a|aac)(?:[?#]|$)/i.test(name)) return 'audio';
    if (/\.(mp4|webm|mov)(?:[?#]|$)/i.test(name)) return 'video';
    return 'file';
  }
  function registerMedia(job, { url, kind = 'file', name = 'Attachment', mime, node, key }) {
    if (active !== job || job.finished) return;
    const safe = safeURL(url);
    if (/svg|html/i.test(mime || '') || /\.(svg|html?)(?:[?#]|$)/i.test(`${url || ''} ${name}`)) kind = 'file';
    // Keep unresolved sandbox/structured references as a visible fallback.
    const identity = key || url || `${kind}:${name}`;
    job.media ||= new Map();
    let entry = job.media.get(identity);
    if (!entry) {
      const label = String(name).replace(/(?:https?:|data:|blob:|sandbox:)\S+/gi, 'Attachment').slice(0, 200);
      entry = { id: `qchat-media-${++mediaSerial}`, kind, name: label || 'Attachment', revision: safe ? 1 : 0, pending: kind === 'image' && !safe, ...(typeof mime === 'string' ? { mime: mime.slice(0, 100) } : {}) };
      job.media.set(identity, entry); media.set(entry.id, { ...entry, url: safe, source: url, node, scope: job });
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
      job.mediaSignature = signature; progress(job);
      emit({ type: 'media', id: job.id, items });
    }
    return entry.id;
  }
  function sourceURL(raw) {
    try {
      const url = new URL(raw);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href.replace(/\(/g, '%28').replace(/\)/g, '%29') : null;
    } catch (_) { return null; }
  }
  function collectSources(job, references) {
    if (!Array.isArray(references)) return;
    job.sources ||= new Map();
    const visit = (reference, inherited = []) => {
      if (!reference || typeof reference !== 'object') return;
      const refId = ref => {
        if (typeof ref === 'string') return ref;
        if (typeof ref?.ref_id === 'string') return ref.ref_id;
        return Number.isInteger(ref?.turn_index) && /^[a-z]+$/i.test(ref?.ref_type || '') && Number.isInteger(ref?.ref_index)
          ? `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}` : null;
      };
      const ownRefs = [refId(reference.ref_id), ...(Array.isArray(reference.refs) ? reference.refs.map(refId) : [])].filter(Boolean);
      const refs = [...ownRefs, ...inherited];
      const page = reference.webpage || reference;
      const url = sourceURL(page.url);
      if (url) {
        const id = refId(page.ref_id) || ownRefs[0] || url;
        const item = { id: String(id), url, title: String(page.title || reference.title || new URL(url).hostname).slice(0, 500) };
        job.sources.set(item.id, item);
        job.sourceRefs ||= new Map();
        for (const ref of [item.id, ...refs]) {
          if (!inherited.includes(ref) || !job.sourceRefs.has(ref)) job.sourceRefs.set(ref, item);
        }
      }
      if (Array.isArray(reference.items)) reference.items.forEach(item => visit(item, refs));
    };
    references.forEach(reference => visit(reference));
    const items = [...job.sources.values()], signature = JSON.stringify(items);
    if (items.length && signature !== job.sourcesSignature) {
      job.sourcesSignature = signature;
      emit({ type: 'sources', id: job.id, items });
    }
  }
  // <Entity value="R34"/> is how the site marks a named thing: its value is the visible text.
  function entityText(text) {
    return window.QResponseTags.toMarkdown(text);
  }
  function citationText(job, text) {
    if (window.QResponseTags.hasInteractive(text)) return text;
    return window.QResponseTags.toMarkdown(text, { citation: refs => refs.split(/\s+/).map(ref => {
      const item = job.sourceRefs?.get(ref);
      return item ? `[${item.title.replace(/[\\[\]]/g, '\\$&').replace(/</g, '&lt;').replace(/[\r\n]/g, ' ')}](${item.url})` : '';
    }).filter(Boolean).join(' ') });
  }
  function attachmentURL(url) {
    return /^(?:sandbox:|blob:|data:)/i.test(url || '') ||
      !!safeURL(url) && /(?:\.oaiusercontent\.com\/|\/(?:backend-api\/)?(?:files|download)\/)/i.test(url || '');
  }
  function markdownMedia(job, text) {
    let rendered = text;
    for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const [, image, label, url] = match;
      if (attachmentURL(url)) {
        const id = registerMedia(job, { url, kind: image ? 'image' : mediaKind(url), name: label || url.split('/').pop()?.split('?')[0] || 'Attachment' });
        if (id) rendered = rendered.replace(match[0], `${image}[${label || 'Attachment'}](qchat-media:${id})`);
      }
    }
    return rendered;
  }
  function structuredMedia(job, part, index) {
    if (!part || typeof part !== 'object') return;
    const type = String(part.content_type || part.type || '');
    if (internalContent(part)) return;
    const mime = part.mime_type || part.mime;
    const url = part.url || part.download_url || part.asset_pointer || part.image_url?.url || (typeof part.image_url === 'string' ? part.image_url : null);
    const name = part.name || part.filename || `${/image|audio|video/i.exec(type)?.[0] || 'Attachment'} ${index + 1}`;
    const kind = /image/i.test(type) ? 'image' : /audio/i.test(type) ? 'audio' : /video/i.test(type) ? 'video' : mediaKind(name, mime);
    const mediaType = /^(?:image|audio|video|file|document|attachment)(?:[_-]|$)/i.test(type);
    const reference = [url, part.filename, part.file_id, part.attachment_id].some(value => typeof value === 'string' && value.length > 0);
    if (mediaType || reference && (part.file_id || part.attachment_id || part.filename || attachmentURL(url)) || /^(?:image|audio|video)\//i.test(mime || '')) {
      registerMedia(job, { url, name, kind, mime, key: url || `${job.message?.id || ''}:${index}:${type}` });
    }
    for (const [key, value] of Object.entries(part)) {
      if ((/^(?:parts|attachments|assets|audio|video|files)$/.test(key) || key === 'images' && mediaType) && Array.isArray(value)) {
        value.forEach((child, n) => { if (typeof child === 'object') structuredMedia(job, child, `${index}.${key}.${n}`); });
      }
    }
  }
  function internalContent(value) {
    const type = String(value?.content_type || value?.type || '');
    return /^(?:thoughts?|reason(?:ing)?|analysis|tool|metadata|debug|notifications?|status|context|citations?|references?|search_result|webpage|image_search|image_result|search_image)(?:[_-]|$)/i.test(type) ||
      !!(value?.channel && value.channel !== 'final') || !!(value?.role && value.role !== 'assistant');
  }
  function domMedia(job, body) {
    for (const node of body?.querySelectorAll('img,audio,video,source,a[href],[data-d-component="pressable"][role="link"][aria-label]') || []) {
      const generated = node.closest('[data-testid="generated-image-gallery"], [data-testid="generated-image-preview"]');
      if (node.closest('[data-testid*="avatar"], [class*="avatar"], [hidden]') || (!generated && node.closest('[aria-hidden="true"]'))) continue;
      const tag = node.tagName?.toLowerCase();
      if (node.getAttribute('data-d-component') === 'pressable' && node.getAttribute('role') === 'link') {
        // Signed-in DIL downloads have no href. Register only the site's proven
        // download-purpose control, leaving URL acquisition to its own handler.
        const match = /^(?:Open\s+)?Download\s+(.+)$/i.exec((node.getAttribute('aria-label') || '').trim());
        if (!match) continue;
        const name = match[1].trim();
        const existing = [...(job.media?.entries() || [])].find(([, item]) => matchingMediaControl(media.get(item.id), node));
        registerMedia(job, { name, kind: mediaKind(name), node, key: existing?.[0] });
        continue;
      }
      if (!['img', 'audio', 'video', 'source', 'a'].includes(tag)) continue;
      const url = tag === 'a' ? node.href : node.currentSrc || node.src;
      const name = node.getAttribute('download') || node.getAttribute('alt') || node.textContent?.trim() || 'Attachment';
      if (!generated && tag === 'img' && (node.closest('a[href]') || !attachmentURL(url))) continue;
      if (tag === 'a' && !node.hasAttribute('download') && !attachmentURL(url)) continue;
      const parentKind = node.parentElement?.tagName?.toLowerCase();
      const kind = tag === 'img' ? 'image' : ['audio', 'video'].includes(tag) ? tag :
        tag === 'source' && ['audio', 'video'].includes(parentKind) ? parentKind : mediaKind(url, node.type);
      // A real anchor can resolve a sandbox reference discovered earlier.
      const existing = [...(job.media?.entries() || [])].find(([, item]) =>
        media.get(item.id)?.node === node || (safeURL(url) && media.get(item.id)?.url === safeURL(url)) ||
        (!media.get(item.id)?.url && !media.get(item.id)?.node && ((kind === 'image' && item.kind === 'image') || (name !== 'Attachment' && (item.name === name || item.name === name.split('/').pop())))));
      registerMedia(job, { url, kind, name, mime: node.type || undefined, node, key: existing?.[0] });
    }
  }
  function imageProgress(job, roots) {
    const nodes = roots.flatMap(root => [root, ...root.querySelectorAll('[role="progressbar"],progress,[aria-live],span,p')]);
    const labels = nodes.filter(node => node.getClientRects?.().length && !node.closest('[hidden], [aria-hidden="true"]')).map(node => ({ node, text: (node.innerText || node.getAttribute?.('aria-label') || '').trim() }));
    const status = labels.find(({text}) => text.length <= 90 && /^(?:Creating|Generating|Rendering|Finishing)(?: an?| your| the)? image(?:[.\u2026\s\d%:]|$)/i.test(text));
    const generated = roots.flatMap(root => [...root.querySelectorAll('[data-testid="generated-image-preview"] img')]).filter(node => !node.hidden && node.complete !== false && node.naturalWidth > 0);
    if (generated.length) {
      const signature = generated.map(node => node.currentSrc || node.src).join('|');
      if (signature !== job.imageSource) { job.imageSource = signature; job.imageStableAt = Date.now(); progress(job); }
    }
    if (!status && !generated.length && !job.sawImageGeneration) return;
    job.sawImageGeneration = true;
    const generating = !!status || !!find('stop') || !generated.length || Date.now() - (job.imageStableAt || Date.now()) < 800;
    const bar = nodes.find(node => node.getAttribute?.('role') === 'progressbar' || node.tagName === 'PROGRESS');
    const raw = bar?.getAttribute('aria-valuenow') ?? bar?.getAttribute('value') ?? /(?:^|\s)(\d{1,3})\s*%/.exec(status?.text || '')?.[1] ?? /^(\d{1,3})\s*%$/.exec(labels.find(({text})=>/^\d{1,3}\s*%$/.test(text))?.text || '')?.[1];
    let percentage = raw == null ? null : Number(raw);
    if (percentage != null && bar) {
      const maximum = Number(bar.getAttribute('aria-valuemax') || bar.getAttribute('max') || 100);
      const minimum = Number(bar.getAttribute('aria-valuemin') || 0);
      percentage = maximum > minimum ? (percentage - minimum) / (maximum - minimum) * 100 : null;
    }
    if (!Number.isFinite(percentage)) percentage = null;
    if (percentage != null) percentage = Math.max(0, Math.min(100, Math.round(percentage)));
    job.imageGenerating = generating;
    const event = { type: 'image_progress', id: job.id, state: generating ? 'generating' : 'complete', ...(generating && percentage != null ? { percentage } : {}) };
    const signature = JSON.stringify(event);
    if (signature !== job.imageProgressSignature) { job.imageProgressSignature = signature; progress(job); emit(event); }
  }
  function completedMarkdown(job, body, plain) {
    if (!body?.childNodes?.length) return plain;
    const escape = text => text.replace(/([\\`*_[\]<>])/g, '\\$1');
    const registered = node => [...(job.media?.values() || [])].find(item => media.get(item.id)?.node === node);
    const normalLink = raw => {
      try {
        const url = new URL(raw, location.href), host = url.hostname;
        if (!raw || url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
            /(?:^|\.)(?:localhost|local|oaiusercontent\.com|oaistatic\.com)$/.test(host) ||
            /^\[|^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./.test(host) ||
            [...url.searchParams.keys()].some(key => /token|signature|^sig$|^se$|^sp$|^sv$|x-amz-/i.test(key))) return null;
        return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
      } catch (_) { return null; }
    };
    const fence = (text, minimum) => '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const walk = node => {
      if (node.nodeType === 3) return escape(node.nodeValue || '');
      const tag = node.tagName?.toLowerCase();
      if (['script', 'style', 'iframe', 'svg', 'button'].includes(tag) || node.hasAttribute?.('hidden') || node.getAttribute?.('aria-hidden') === 'true') return '';
      if (tag === 'pre') {
        const code = node.querySelector('code') || node;
        const text = (code.textContent || '').replace(/\n$/, '');
        const language = /(?:^|\s)language-([\w+-]+)/.exec(code.className || '')?.[1] || '';
        const ticks = fence(text, 3);
        return `\n\n${ticks}${language}\n${text}\n${ticks}\n\n`;
      }
      if (tag === 'code') {
        const text = node.textContent || '', ticks = fence(text, 1), pad = text.includes('`') ? ' ' : '';
        return `${ticks}${pad}${text}${pad}${ticks}`;
      }
      if (tag === 'br') return '\n';
      const children = [...(node.childNodes || [])].map(walk).join('');
      if (node.getAttribute?.('data-d-component') === 'pressable' && node.getAttribute?.('role') === 'link') {
        const item = registered(node);
        if (item) return `[${children || escape(item.name)}](qchat-media:${item.id})`;
      }
      if (tag === 'strong' || tag === 'b') return `**${children}**`;
      if (tag === 'em' || tag === 'i') return `*${children}*`;
      if (/^h[1-6]$/.test(tag || '')) return `\n\n${'#'.repeat(Number(tag[1]))} ${children.trim()}\n\n`;
      if (tag === 'ul' || tag === 'ol') {
        const start = Number(node.getAttribute('start')) || 1;
        const items = [...node.childNodes].filter(child => child.tagName?.toLowerCase() === 'li');
        return '\n\n' + items.map((item, i) => `${tag === 'ol' ? `${start + i}.` : '-'} ${walk(item).trim().replace(/\n/g, '\n  ')}`).join('\n') + '\n\n';
      }
      if (tag === 'a' || tag === 'img' || tag === 'audio' || tag === 'video' || tag === 'source') {
        const item = registered(node);
        if (item) return `${tag === 'img' ? '!' : ''}[${children || escape(item.name)}](qchat-media:${item.id})`;
        if (tag === 'a') { const url = normalLink(node.href || node.getAttribute('href')); return url ? `[${children}](${url})` : children; }
        return '';
      }
      if (tag === 'p') return `\n\n${children.trim()}\n\n`;
      return children;
    };
    return walk(body).trim() || plain;
  }
  function sampleDOM(job) {
    if (active !== job || job.finished || job.cancelled) return;
    const nodes = currentAssistants(job);
    // Inspect only explicit, visible status surfaces in this submitted turn.
    // Never infer tool use from reply prose, source links, or old turns.
    const statuses = nodes.flatMap(root => [root, ...root.querySelectorAll('[role="status"],[aria-live],[data-testid="tool-status"],[data-testid="search-status"]')]);
    let domActivity;
    for (const status of statuses) {
      if (!status.getClientRects?.().length || status.closest('[hidden], [aria-hidden="true"]')) continue;
      if (status.getAttribute('role') !== 'status' && !status.hasAttribute('aria-live') && !['tool-status', 'search-status'].includes(status.getAttribute('data-testid'))) continue;
      const label = (status.innerText || status.getAttribute('aria-label') || '').trim();
      if (/^Searching(?: the)? web(?:\.{3}|\u2026)?$/i.test(label)) domActivity = { kind: 'search', label: 'Searching the web' };
      else if (/^(?:Reading|Browsing) sources(?:\.{3}|\u2026)?$/i.test(label)) domActivity = { kind: 'browse', label: 'Reading sources' };
      else if (/^(?:Running|Executing) code(?:\.{3}|\u2026)?$/i.test(label)) domActivity = { kind: 'code', label: 'Running code' };
    }
    if (domActivity) {
      if (job.domActivityKind !== domActivity.kind && job.activity?.kind !== domActivity.kind) startActivity(job, domActivity, `dom:${domActivity.kind}`);
      job.domActivityKind = domActivity.kind;
    } else {
      job.domActivityKind = null;
      if (job.activityKey?.startsWith('dom:')) completeActivity(job);
    }
    for (const root of nodes) domMedia(job, root);
    imageProgress(job, nodes);
    const node = nodes[nodes.length - 1];
    job.assistantNode = node;
    const body = node && (selectors.body.map(s => node.querySelector(s)).find(Boolean) || node);
    const plain = body?.innerText?.trim() || '';
    let text = job.requiresDOM || body?.querySelector('[data-testid="generated-image-gallery"]') ? completedMarkdown(job, body, plain) : plain;
    // DIL is a layout language, not answer text. A source/copy surface can
    // mount before the real rendered content; never forward that surface.
    if (richLayout(text)) text = '';
    if (domActivity && /^(?:Searching(?: the)? web|(?:Reading|Browsing) sources|(?:Running|Executing) code)(?:\.{3}|\u2026)?$/i.test(text)) text = '';
    if (body) domMedia(job, body);
    if (text && text !== job.domText && !window.QResponseTags.hasInteractive(job.netText)) {
      job.domText = text; job.stableAt = Date.now(); progress(job);
      if ((!job.canonicalFallback && (!job.netText || job.detached)) || job.requiresDOM) { job.text = text; delta(job); }
    }
    // Current signed-in DIL streams can contain richer updates than the parsed
    // text packets. At completion prefer a longer scoped visible reply over a
    // stale network prefix; retain network markdown when it already covers it.
    const dil = job.assistantNode?.hasAttribute('data-dil-source-message-id');
    if (text && job.finishing && !window.QResponseTags.hasInteractive(job.netText) && (job.requiresDOM || !job.canonicalFallback && (text.length > (dil ? (job.netText || '').length : job.text.length) || job.domPreferred || (dil && job.detached)))) {
      job.domPreferred = true;
      job.text = dil ? completedMarkdown(job, body, text) : text;
      delta(job);
    }
    if (!job.conversationId) job.conversationId = location.pathname.match(/^\/(?:c|uc)\/([^/]+)/)?.[1];
    if (find('stop')) job.sawStop = true;
    if (find('stop')) job.noStopAt = null;
    else job.noStopAt ||= Date.now();
    if ((!job.stream || (job.sawImageGeneration && !job.imageGenerating)) && (job.domText || job.media?.size) && !find('stop') && !job.imageGenerating &&
        (job.sawStop || job.streamEnded) && Date.now() - (job.stableAt || job.noStopAt) >= 800 &&
        Date.now() - job.noStopAt >= 800) finish(job);
  }
  function richLayout(text) {
    return window.QResponseTags.hasLayout(text);
  }
  function networkText(job, text, canonicalFallback = false) {
    if (active !== job || job.finished || job.finishing) return;
    job.netText = text;
    job.canonicalFallback = canonicalFallback;
    const interactive = window.QResponseTags.hasInteractive(text);
    job.requiresDOM = !interactive && richLayout(text);
    job.rich = job.rich || job.requiresDOM || interactive;
    if (job.requiresDOM) { sampleDOM(job); return; }
    job.text = markdownMedia(job, text) || (!canonicalFallback && job.domText) || '';
    delta(job);
  }
  function applyNDJSON(job, packet) {
    if (!packet || typeof packet !== 'object') return;
    if (active !== job || job.finished || job.finishing || job.cancelled) return;
    // The NDJSON transport also accepts the same message envelopes as SSE.
    if (packet.message || packet.author && packet.content) { apply(job, packet); return; }
    if (packet.type === 'content' && packet.recipient && !['all', 'all_tools'].includes(packet.recipient)) {
      messageActivity(job, { ...packet, id: packet.messageId, author: packet.author || { role: packet.role || 'assistant' } }); return;
    }
    if (packet.channel && packet.channel !== 'final' || packet.role && packet.role !== 'assistant' || packet.author?.role && packet.author.role !== 'assistant') return;
    if (packet.detail?.conversationId) job.conversationId = packet.detail.conversationId;
    if (['done', 'completed', 'finish'].includes(packet.type)) { job.protocolDone = true; return; }
    if (packet.type === 'error') { fail(job, 'stream_failed', 'ChatGPT reported a response error. View the conversation in ChatGPT.'); return; }
    if (packet.type === 'content') {
      if (job.previousAssistantIds.has(packet.messageId)) return;
      if (packet.messageId) job.responseIds.add(packet.messageId);
      const messages = job.contents ||= new Map();
      const prior = messages.get(packet.messageId);
      if (prior && packet.revision <= prior.revision) return;
      if (packet.mode === 'append' && prior && packet.baseRevision !== prior.revision) {
        debug('Revision gap', packet.baseRevision, prior.revision); return;
      }
      // These packets carry layout whose images only the saved record can show.
      if (packet.dil) job.rich = true;
      const fragment = typeof packet.markdown === 'string' ? packet.markdown : '';
      const markdown = packet.mode === 'append' ? (prior?.markdown || '') + fragment : fragment;
      // DIL fallbackMarkdown is a complete snapshot even on append packets.
      const fallback = typeof packet.dil?.fallbackMarkdown === 'string' ? packet.dil.fallbackMarkdown : (packet.mode === 'append' ? prior?.fallback : undefined);
      // fallbackMarkdown is an authoritative full snapshot, even when the
      // accompanying layout/markdown field is an append delta. Never combine
      // the two representations or retain an earlier rendered prefix.
      const text = window.QResponseTags.hasInteractive(markdown) ? markdown : typeof fallback === 'string' ? fallback : markdown;
      collectSources(job, packet.metadata?.content_references);
      if (Array.isArray(packet.parts)) packet.parts.forEach((part, i) => structuredMedia(job, part, i));
      messages.set(packet.messageId, { revision: packet.revision, markdown, fallback, text });
      if (text) completeActivity(job);
      networkText(job, [...messages.values()].map(m => m.text).join('\n\n'), [...messages.values()].every(m => typeof m.fallback === 'string'));
    } else apply(job, packet);
  }
  function visible(message) {
    return message && message.author && message.author.role === 'assistant' &&
      (!message.channel || message.channel === 'final') &&
      !message.metadata?.is_visually_hidden_from_conversation && !internalContent(message.content) && message.recipient !== 'all_tools' &&
      (!message.recipient || message.recipient === 'all');
  }
  function apply(job, packet) {
    if (!packet || typeof packet !== 'object') return;
    if (active !== job || job.finished || job.finishing || job.cancelled) return;
    if (packet.error) { fail(job, 'stream_failed', 'ChatGPT reported a response error. View the conversation in ChatGPT.'); return; }
    if (packet.op && packet.path !== undefined) packet = { ...packet, p: packet.path, o: packet.op, v: packet.value };
    if (packet.conversation_id) job.conversationId = packet.conversation_id;
    if (packet.message) job.message = packet.message;
    else if (packet.author && packet.content) job.message = packet;
    if (packet.o === 'patch' && Array.isArray(packet.v)) { packet.v.forEach(op => apply(job, op)); return; }
    if (!Object.prototype.hasOwnProperty.call(packet, 'v')) { renderMessage(job); return; }
    if (packet.p !== undefined) job.path = packet.p;
    if (packet.o !== undefined) job.operation = packet.o;
    const path = packet.p === undefined ? job.path : packet.p;
    const operation = packet.o === undefined ? job.operation : packet.o;
    const value = packet.v;
    if (value && typeof value === 'object' && value.message) {
      job.message = value.message;
      if (value.conversation_id) job.conversationId = value.conversation_id;
    } else if (value?.author && value?.content) job.message = value;
    else if (path && job.message) {
      const keys = path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) return;
      let target = { message: job.message };
      for (let i = 0; i < keys.length - 1; i++) {
        target = target[keys[i]];
        if (!target || typeof target !== 'object') return;
      }
      const key = keys[keys.length - 1];
      if (Array.isArray(target) && operation === 'add') {
        if (key === '-') target.push(value);
        else if (/^\d+$/.test(key)) target.splice(Number(key), 0, value);
      } else if (operation === 'append') {
        if (typeof target[key] === 'string' && typeof value === 'string') target[key] += value;
        else if (Array.isArray(target[key])) target[key].push(...(Array.isArray(value) ? value : [value]));
      } else if (operation === 'remove') delete target[key];
      else target[key] = value;
    }
    renderMessage(job);
  }
  function renderMessage(job) {
    messageActivity(job, job.message);
    if (!visible(job.message)) return;
    if (job.previousAssistantIds.has(job.message.id)) return;
    if (job.message.id) job.responseIds.add(job.message.id);
    collectSources(job, job.message.metadata?.content_references);
    const content = job.message.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [content];
    let text = '', hasText = false;
    parts.forEach((part, i) => {
      if (typeof part === 'string') { text += part; hasText = true; }
      else if (part && ['text', 'output_text'].includes(part.type || part.content_type) && typeof part.text === 'string') { text += part.text; hasText = true; }
      else structuredMedia(job, part, i);
    });
    if (hasText) { if (text) completeActivity(job); networkText(job, text); }
  }
  function detach(job, reason) {
    if (active !== job || job.finished || job.finishing) return;
    debug('Stream observer detached', reason);
    disposeReader(job); job.stream = false; job.detached = true; sampleDOM(job);
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
          if (value === '[DONE]') { job.protocolDone = true; return true; }
          try { apply(job, JSON.parse(value)); } catch (e) { debug('SSE', e.message); }
        }
      };
      let ended = false;
      while (active === job && !job.finished && !ended) {
        const { value, done } = await job.reader.read();
        if (active !== job || job.finished || job.finishing) return;
        progress(job); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          if (line(raw)) { ended = true; break; }
        }
        if (done) { if (buffer.trim()) line(buffer); line(''); break; }
      }
      // Never await cancel on a clone: tee cancellation can remain pending while
      // the site consumes its branch. EOF without a terminal packet is recoverable.
      if (job.protocolDone) {
        job.streamEnded = true;
        await finish(job);
      } else detach(job, 'EOF before terminal packet');
    } catch (e) { detach(job, e.message); }
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let job, upload = false;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = (init?.method || input?.method || 'GET').toUpperCase();
      upload = ['POST', 'PUT'].includes(method) && /\/(?:files|uploads?)(?:\/|$)|\/upload/i.test(url.pathname);
      // Prepare can prefetch while typing, before React enables the real Send button.
      if (method === 'POST' && /\/(?:backend-(?:api|anon)|unauth-mweb)\/(?:f\/)?conversation(?:\/updates)?\/?$/.test(url.pathname) && active) {
        const current = active;
        if (!current.started) {
          try {
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            const ids = body?.messages?.filter(message => (message.author?.role || message.role) === 'user').map(message => message.id).filter(Boolean);
            if (ids?.length) current.userMessageIds = new Set(ids.slice(-1));
          } catch (_) {}
          current.started = true; clearTimeout(current.startTimer); progress(current);
          emit({ type: 'start', id: current.id });
        }
        if (!window.__QCHAT_DISABLE_NET__ && !current.stream) {
          job = current; job.stream = true;
        }
      }
    } catch (_) {}
    const request = originalFetch.apply(this, arguments);
    if (upload) {
      uploads++;
      request.then(response => { uploads--; if (!response.ok) uploadFailureAt = Date.now(); }, () => { uploads--; uploadFailureAt = Date.now(); });
    }
    if (job) request.then(response => { try { observe(response.clone(), job); } catch (e) { detach(job, e.message); } }, e => fail(job, 'stream_failed', e.message));
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
      if (/You've reached our limit|You\u2019ve reached our limit|reached your.*limit/i.test(text)) return ['rate_limited', 'Guest chat limit reached.'];
      const stay = [...wall.querySelectorAll('button')].find(b => /stay logged out/i.test(b.textContent));
      if (stay) { stay.click(); continue; }
      if (/log in|sign up/i.test(text) && !composer) return ['auth', 'Login dialog is blocking chat.'];
    }
  }
  function composerArea() {
    const composer = find('composer');
    return composer?.closest('form') || composer?.parentElement?.parentElement;
  }
  function attachmentRemovers(names = []) {
    return [...(composerArea()?.querySelectorAll('button') || [])].filter(node => {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
      const label = (node.getAttribute('aria-label') || '').trim();
      const testid = node.getAttribute('data-testid') || '';
      return /^remove (?:file|attachment)(?:\b|$)/i.test(label) || /^remove-(?:file|attachment)(?:-|$)/i.test(testid) ||
        names.some(name => label.toLowerCase() === `remove ${name}`.toLowerCase());
    });
  }
  async function clearFailedAttachments(job) {
    const controls = attachmentRemovers(job.attachmentNames);
    cancelledAttachments = { names: job.attachmentNames, hadControls: controls.length >= job.attachmentCount };
    let clicked = true;
    controls.forEach(node => { try { node.click(); } catch (_) { clicked = false; } });
    if (!cancelledAttachments.hadControls || !clicked) return false;
    // React may remove the chips after the click task has ended. Never upload
    // another copy until both the controls and the in-flight upload are gone.
    for (let i = 0; i < 20 && active === job && !job.finished; i++) {
      if (uploads === 0 && attachmentRemovers(job.attachmentNames).length === 0) { cancelledAttachments = null; return true; }
      await sleep(50);
    }
    return false;
  }
  async function attachmentInput() {
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
      const area = composerArea();
      const button = [...(area?.querySelectorAll('button') || [])].find(node =>
        /attach|add files|upload|files and more/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-testid') || ''} ${node.textContent || ''}`));
      if (button && !button.disabled) button.click();
      for (let i = 0; i < 30 && !(input = choose()); i++) {
        // Opening a menu is safe; do not click a file command that launches a picker.
        await sleep(100);
      }
    }
    if (!input) throw new Error('ChatGPT attachment input is unavailable. Open attachments in ChatGPT and try again.');
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
    if (!entry) throw new Error('This attachment is unavailable. View it in ChatGPT.');
    return transportValue({ kind: entry.kind, name: entry.name, ...(entry.mime ? { mime: entry.mime } : {}) });
  }
  function mediaControls(entry) {
    const turn = currentAssistants(entry.scope).at(-1);
    if (turn) entry.scope.assistantNode = turn;
    if (!turn) return [];
    return [...turn.querySelectorAll('a[href],button,[data-d-component="pressable"][role="link"]')];
  }
  function matchingMediaControl(entry, node) {
    if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true' ||
        node.closest('[aria-hidden="true"], [data-testid*="avatar"], [class*="avatar"]')) return false;
    const tag = node.tagName?.toLowerCase();
    const labels = [node.getAttribute('download'), node.textContent?.trim(), node.getAttribute('aria-label')].filter(Boolean).map(value => value.replace(/^open\s+/i, ''));
    const label = labels.join(' ');
    const filename = (() => { try { return decodeURIComponent(new URL(entry.source || '', location.href).pathname.split('/').pop()); } catch (_) { return ''; } })();
    const names = [entry.name, filename].filter(name => name && name !== 'Attachment');
    const nameMatches = names.some(name => labels.some(label => label === name || label.toLowerCase() === `download ${name}`.toLowerCase()));
    if (tag === 'a') {
      const href = node.href || node.getAttribute('href') || '';
      const linkName = (() => { try { return decodeURIComponent(new URL(href, location.href).pathname.split('/').pop()); } catch (_) { return ''; } })();
      return (nameMatches || names.includes(linkName)) && (!!safeURL(href) || /^sandbox:\/[^\r\n]*$/.test(href));
    }
    const downloadLabel = /download/i.test(`${label} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-testid') || ''}`);
    return nameMatches && downloadLabel && (tag === 'button' ||
      node.getAttribute('data-d-component') === 'pressable' && node.getAttribute('role') === 'link');
  }
  function visibleDownloadControls() {
    return [...document.querySelectorAll('button[aria-label="Download file"]')].filter(node =>
      !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length &&
      !node.closest('[hidden], [aria-hidden="true"]'));
  }
  function mediaPoint(control) {
    control.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = control.getBoundingClientRect();
    const x = Number(rect.left ?? rect.x) + Number(rect.width) / 2;
    const y = Number(rect.top ?? rect.y) + Number(rect.height) / 2;
    const width = window.innerWidth || document.documentElement?.clientWidth;
    const height = window.innerHeight || document.documentElement?.clientHeight;
    if (![x, y, rect.width, rect.height, width, height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error('This attachment download control is not visible. View it in ChatGPT.');
    }
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : control;
    if (hit !== control && !control.contains?.(hit)) throw new Error('This download control is covered. View it in ChatGPT.');
    return { x, y };
  }
  function mediaDownloadAction(id) {
    const entry = media.get(id);
    if (!entry || downloadActivation?.id !== id || Date.now() - downloadActivation.at > 30000) return null;
    const visible = visibleDownloadControls();
    const fresh = visible.filter(node => !downloadActivation.existing.has(node));
    let control;
    if (fresh.length > 1) throw new Error('More than one file download is visible. View this attachment in ChatGPT.');
    if (fresh.length === 1) control = fresh[0];
    else {
      const filename = (() => { try { return decodeURIComponent(new URL(entry.source || '', location.href).pathname.split('/').pop()); } catch (_) { return ''; } })();
      const names = [filename, entry.name.replace(/^(?:Open\s+)?Download\s+/i, '')].filter(name => name && name !== 'Attachment');
      const matching = visible.filter(node => {
        let parent = node.parentElement;
        for (let depth = 0; parent && depth < 4 && parent !== document.body && parent !== document.documentElement; depth++, parent = parent.parentElement) {
          if (['MAIN', 'HTML', 'BODY'].includes(parent.tagName)) break;
          if (names.some(name => (parent.innerText || parent.textContent || '').includes(name))) return true;
        }
        return false;
      });
      if (matching.length > 1) throw new Error('More than one file download matches. View this attachment in ChatGPT.');
      control = matching[0];
    }
    if (!control) return null;
    if (typeof control.getBoundingClientRect !== 'function') throw new Error('This attachment download control is unavailable. View it in ChatGPT.');
    return { ...mediaInfo(id), point: mediaPoint(control) };
  }
  async function activateMedia(id, { coordinates = false } = {}) {
    const entry = media.get(id);
    if (!entry) throw new Error('This attachment is unavailable. View it in ChatGPT.');
    // This API is invoked only for a manual native Save/Load action. Let the
    // site's existing handler obtain signed URLs and start a normal download.
    const controls = mediaControls(entry);
    const control = controls.find(node => node === entry.node && matchingMediaControl(entry, node)) ||
      controls.find(node => matchingMediaControl(entry, node));
    if (!control || typeof control.click !== 'function') throw new Error('This attachment download is unavailable. View it in ChatGPT.');
    if (coordinates && typeof control.getBoundingClientRect === 'function') {
      const point = mediaPoint(control);
      downloadActivation = { id, existing: new Set(visibleDownloadControls()), at: Date.now() };
      return { ...mediaInfo(id), point };
    }
    downloadActivation = { id, existing: new Set(visibleDownloadControls()), at: Date.now() };
    control.click();
    return mediaInfo(id);
  }
  // Files in saved conversations are addressed by id, so they outlive any page or session.
  async function resolveStoredMedia(file, conversation) {
    const token = await sessionToken();
    const info = await readJSON(`/backend-api/files/download/${file}?conversation_id=${conversation}&inline=true`, token);
    const url = safeURL(info?.download_url);
    if (!url) throw new Error('This attachment is unavailable. View it in ChatGPT.');
    const name = String(info.file_name || 'Image').slice(0, 200);
    const mime = typeof info.mime_type === 'string' ? info.mime_type : undefined;
    const kind = mediaKind(name, mime);
    if (new URL(url, location.href).origin !== location.origin) return { url, kind, name, ...(mime ? { mime } : {}) };
    // Same-origin content needs the session header, which the native loader cannot add.
    const response = await originalFetch(url, { credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('This attachment is unavailable. View it in ChatGPT.');
    const blob = URL.createObjectURL(await response.blob());
    setTimeout(() => URL.revokeObjectURL(blob), 60000);
    return { url: blob, kind, name, ...(mime ? { mime } : {}) };
  }
  async function resolveMedia(id) {
    const stored = /^stored:([A-Za-z0-9_-]{4,120}):([A-Za-z0-9_-]{8,80})$/.exec(id);
    if (stored) return resolveStoredMedia(stored[1], stored[2]);
    if (id?.startsWith('webimage:')) {
      const url = atob(id.slice(9).replace(/-/g, '+').replace(/_/g, '/'));
      if (new URL(url).hostname !== 'images.openai.com') throw new Error('This image is unavailable.');
      return { url, kind: 'image', name: 'Image.jpg', mime: 'image/jpeg' };
    }
    const entry = media.get(id);
    if (!entry) throw new Error('This attachment is unavailable. View it in ChatGPT.');
    if (!entry.url && !entry.node) {
      // Download anchors can mount after the terminal stream packet. Search only
      // assistant turns created for this job and match the displayed filename.
      const turn = currentAssistants(entry.scope).at(-1);
      if (turn) entry.scope.assistantNode = turn;
      const links = [...(turn?.querySelectorAll('a[href]') || [])];
      entry.node = links.find(node => (node.getAttribute('download') || node.textContent?.trim()) === entry.name && safeURL(node.href));
    }
    let url = safeURL(entry.node?.currentSrc || entry.node?.src || entry.node?.href || entry.url);
    if (!url) throw new Error('This attachment cannot be downloaded here. View it in ChatGPT.');
    const parsed = new URL(url, location.href);
    if (entry.kind === 'file' && parsed.origin === new URL(location.href).origin && /\/(?:backend-api\/)?(?:files|download)\//i.test(parsed.pathname)) {
      const controller = new AbortController(); let timer;
      try {
        const response = await Promise.race([
          originalFetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 8000); })
        ]);
        if (!response.ok) throw new Error('download unavailable');
        if (/application\/json/i.test(response.headers.get('content-type') || '')) {
          // Keep the body read in the same deadline and bound JSON before parsing.
          const readMetadata = async () => {
            if (!response.body?.getReader) return response.text();
            const reader = response.body.getReader();
            const decoder = new TextDecoder(); let raw = '', size = 0;
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) return raw + decoder.decode();
                size += value.byteLength;
                if (size > 65536) { controller.abort(); throw new Error('download metadata too large'); }
                raw += decoder.decode(value, { stream: true });
              }
            } finally { reader.releaseLock(); }
          };
          const raw = await Promise.race([readMetadata(), new Promise((_, reject) => {
            clearTimeout(timer); timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 8000);
          })]);
          if (raw.length > 65536) throw new Error('download metadata too large');
          const data = JSON.parse(raw); url = safeURL(data.download_url || data.url);
          if (!url) throw new Error('download URL unavailable');
        }
      } catch (_) { throw new Error('This attachment cannot be downloaded here. View it in ChatGPT.'); }
      finally { clearTimeout(timer); }
    }
    return { url, kind: entry.kind, name: entry.name, ...(entry.mime ? { mime: entry.mime } : {}) };
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
  // Select only explicitly labelled thinking controls, never model entries.
  let reasoningSelection = false;
  async function selectReasoning(job, composer, effort) {
    if (effort == null) return true;
    const alive = () => active === job && !job.cancelled;
    const shown = node => node && node.isConnected !== false && node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]');
    const label = node => (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim();
    const accessibleName = node => {
      const ids = node.getAttribute('aria-labelledby');
      return ids ? ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() : label(node);
    };
    const names = { low: ['Light', 'Low', 'Instant'], medium: ['Standard', 'Medium'], high: ['Extended', 'High'] };
    const unsupported = () => {
      if (alive()) fail(job, 'reasoning_unavailable', 'This ChatGPT control cannot verify that thinking level. Choose Medium reasoning or a model with labelled thinking controls in ChatGPT.');
      return false;
    };
    if (!names[effort]) return unsupported();
    const controls = [...(composerArea()?.querySelectorAll('button[aria-haspopup]') || [])].filter(node =>
      shown(node) && (/^Thinking(?: time)?(?:[:,].*)?$/i.test(label(node)) || /^(Light|Low|Standard|Medium|Extended|High)$/.test(label(node))));
    // The model switcher may be opened, but only its Thinking group is writable.
    const modelControls = controls.length ? [] : [...document.querySelectorAll('button[data-testid="model-switcher-dropdown-button"][aria-haspopup], button[aria-label="Select ChatGPT model"][aria-haspopup]')].filter(shown);
    if (!controls.length && !modelControls.length) return effort === 'medium' || unsupported();
    if ((controls.length || modelControls.length) !== 1) return unsupported();
    const modelMenu = !controls.length;
    const control = (modelMenu ? modelControls : controls)[0];
    if (control.disabled || control.getAttribute('aria-disabled') === 'true' || control.getAttribute('aria-expanded') === 'true') return unsupported();
    let opened = false;
    reasoningSelection = true;
    const popup = () => {
      const id = control.getAttribute('aria-controls');
      const menu = id && document.getElementById(id);
      return shown(menu) && control.getAttribute('aria-expanded') === 'true' ? menu : null;
    };
    const scope = menu => {
      if (!modelMenu) return menu;
      const groups = [...menu.querySelectorAll('[role="radiogroup"], [role="group"]')].filter(node => shown(node) && /^Thinking(?: time)?$/i.test(accessibleName(node)));
      return groups.length === 1 ? groups[0] : null;
    };
    const options = () => {
      const menu = popup(), group = menu && scope(menu);
      return group ? [...group.querySelectorAll('[role="menuitemradio"], [role="option"], [role="radio"]')].filter(shown) : [];
    };
    const matches = () => options().filter(node => names[effort].includes(label(node).split('\n')[0].trim()));
    const selected = node => node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true';
    // Current ChatGPT exposes keyboard input on a Power menuitem; its visual
    // Radix slider is aria-hidden. The linked live status names every position.
    const selectPower = async () => {
      const read = () => {
        const menu = popup();
        const powers = [...(menu?.querySelectorAll('[data-reasoning-slider][role="menuitem"][aria-label="Power"]') || [])].filter(shown);
        if (powers.length !== 1) return null;
        const power = powers[0];
        if (power.getAttribute('aria-disabled') === 'true') return null;
        const statuses = (power.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id))
          .filter(node => node && menu.contains(node) && node.getAttribute('role') === 'status');
        if (statuses.length !== 1) return null;
        const status = (statuses[0].textContent || '').trim().match(/^(Instant|Light|Low|Medium|Standard|High|Extended), ([1-3]) of 3\.$/);
        if (!status) return null;
        const index = Number(status[2]), level = ['low', 'medium', 'high'][index - 1];
        return names[level].includes(status[1]) ? { power, index, level } : null;
      };
      const desired = ['low', 'medium', 'high'].indexOf(effort) + 1;
      for (let step = 0; step < 3 && alive(); step++) {
        const before = read();
        if (!before) return unsupported();
        if (before.level === effort) return true;
        const key = before.index < desired ? 'ArrowRight' : 'ArrowLeft';
        before.power.focus?.();
        before.power.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        let changed;
        for (let i = 0; i < 20 && alive(); i++) {
          await sleep(50);
          changed = read();
          if (changed && changed.index !== before.index) break;
        }
        if (!alive()) return false;
        if (!changed || changed.index !== before.index + (key === 'ArrowRight' ? 1 : -1)) return unsupported();
      }
      return alive() ? unsupported() : false;
    };
    try {
      if (!alive()) return false;
      opened = true;
      control.focus?.();
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
      await sleep(50);
      if (!alive()) return false;
      if (control.getAttribute('aria-expanded') !== 'true') control.click();
      for (let i = 0; i < 30 && alive() && !popup(); i++) await sleep(50);
      if (!alive()) return false;
      if ([...(popup()?.querySelectorAll('[data-reasoning-slider][role="menuitem"][aria-label="Power"]') || [])].some(shown)) return await selectPower();
      const found = matches();
      if (found.length !== 1) return unsupported();
      const option = found[0];
      if (option.disabled || option.getAttribute('aria-disabled') === 'true') return unsupported();
      if (!selected(option)) option.click();
      let reopened = false;
      for (let i = 0; i < 20 && alive(); i++) {
        // Re-query live state: a detached radio's checked state is not evidence.
        const fresh = matches();
        if (fresh.length === 1 && selected(fresh[0])) return true;
        if (!modelMenu && shown(control) && names[effort].includes(label(control))) return true;
        if (!popup() && !reopened && shown(control)) { control.click(); reopened = true; }
        await sleep(50);
      }
      return alive() ? unsupported() : false;
    } finally {
      if (opened && control.getAttribute('aria-expanded') === 'true') {
        const target = popup() || control;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      }
      reasoningSelection = false;
    }
  }
  window.__qchat = {
    attachmentInput,
    cancelAttachmentSelection,
    mediaInfo,
    activateMedia,
    mediaDownloadAction,
    resolveMedia,
    async send({ id, prompt = '', attachmentCount = 0, reasoningEffort }) {
      if (reasoningEffort != null && !['low', 'medium', 'high'].includes(reasoningEffort)) { error(id, 'invalid_reasoning_effort', 'Choose low, medium or high reasoning.'); return; }
      if (active || reasoningSelection) { error(id, 'busy', 'A request is already in progress.'); return; }
      if (cancelledAttachments) {
        const cleared = cancelledAttachments.hadControls && uploads === 0 && attachmentRemovers(cancelledAttachments.names).length === 0;
        if (cleared) cancelledAttachments = null;
        else { error(id, 'attachment_pending', 'Cancelled attachments may still be in ChatGPT. Clear them there or start a new chat before sending.'); return; }
      }
      const attachmentNames = [...document.querySelectorAll('input[type="file"]')].flatMap(input => [...(input.files || [])].map(file => file.name));
      let settle;
      const settled = new Promise(resolve => { settle = resolve; });
      const previousAssistants = assistantNodes(), previousUsers = [...document.querySelectorAll(userSelector)];
      const job = active = { id, attachmentCount, attachmentNames, settled, settle, prompt: prompt.trim(), text: '', sentText: '', lastDelta: 0,
        responseIds: new Set(), scopedAssistants: new Set(), previousAssistants: new Set(previousAssistants), previousAssistantIds: new Set(previousAssistants.flatMap(messageIds)),
        previousUsers: new Set(previousUsers), previousUserIds: new Set(previousUsers.flatMap(messageIds)) };
      job.observer = new MutationObserver(() => sampleDOM(job));
      job.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      job.domTimer = setInterval(() => sampleDOM(job), 100);
      progress(job);
      try {
        let composer;
        for (let i = 0; i < 150 && active === job && !job.cancelled; i++) {
          const block = blocking(); if (block) { fail(job, ...block); return; }
          composer = find('composer'); if (composer) break; await sleep(100);
        }
        if (active !== job || job.cancelled) return;
        if (!composer) { fail(job, 'not_ready', 'Composer did not appear within 15 seconds.'); return; }
        if (reasoningEffort != null && !await selectReasoning(job, composer, reasoningEffort)) return;
        if (active !== job || job.cancelled) return;
        composer = find('composer');
        if (!composer) { fail(job, 'not_ready', 'ChatGPT composer changed. Please try again.'); return; }
        composer.focus();
        if (composer.tagName === 'TEXTAREA') {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, prompt);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll', false); document.execCommand('insertText', false, prompt);
        }
        let uploadQuietAt = Date.now();
        const attempts = attachmentCount > 0 ? 1200 : 100;
        for (let i = 0; i < attempts && active === job && !job.started && !job.cancelled; i++) {
          if (attachmentCount > 0) {
            if (uploadFailureAt >= attachmentSelectionAt && Number.isFinite(uploadFailureAt)) {
              fail(job, 'attachment_failed', 'ChatGPT could not upload an attachment. Check it in ChatGPT.'); return;
            }
            const area = composerArea();
            const alerts = [...(area?.querySelectorAll('[role="alert"], [data-testid*="error"]') || [])].map(node => node.textContent || '').join(' ');
            if (/failed|couldn.t|unable|unsupported|too large|limit|not supported|error/i.test(alerts)) {
              fail(job, 'attachment_failed', 'ChatGPT rejected an attachment. Check the attachment in ChatGPT.'); return;
            }
            const pending = uploads > 0 || !!area?.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid*="uploading"], [data-state="uploading"]');
            if (pending) uploadQuietAt = Date.now();
            if (pending || Date.now() - uploadQuietAt < 800) { await sleep(100); continue; }
          }
          const button = find('send');
          if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
            job.startTimer = setTimeout(() => fail(job, 'send_failed', 'No conversation request started within 20 seconds.'), 20000);
            job.submitted = true; button.click(); return;
          }
          const block = blocking(); if (block) { fail(job, ...block); return; }
          await sleep(100);
        }
        if (active === job && !job.started && !job.cancelled) {
          if (attachmentCount > 0) { fail(job, 'attachment_failed', 'Attachments did not become ready within two minutes. Check them in ChatGPT.'); return; }
          job.startTimer = setTimeout(() => fail(job, 'send_failed', 'No conversation request started within 20 seconds.'), 20000);
          job.submitted = true; composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        }
      } catch (e) { fail(job, 'send_failed', e.message); }
    },
    stop() {
      const job = active; if (!job) return Promise.resolve();
      job.cancelled = true;
      completeActivity(job);
      if (!job.started && job.attachmentCount > 0) {
        const controls = attachmentRemovers(job.attachmentNames);
        cancelledAttachments = { names: job.attachmentNames, hadControls: controls.length >= job.attachmentCount };
        controls.forEach(node => { try { node.click(); } catch (_) {} });
        if (!controls.length) {
          fail(job, 'attachment_cancelled', 'Stopped before sending. Clear the pending attachments in ChatGPT or start a new chat before sending again.'); return job.settled;
        }
      }
      try { find('stop')?.click(); } catch (_) {}
      finish(job, false);
      return job.settled;
    },
    async readConversation(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('invalid_id');
      // The account's own record is complete and needs no navigation. The rendered
      // page below is the fallback for guests and for any change to that endpoint.
      const stored = await storedMessages(id).catch(() => null);
      if (stored) { emit({ type: 'transcript', conversationId: id, messages: stored, complete: true }); return; }
      if (!location.pathname.endsWith('/c/' + id)) { emit({ type: 'transcript', conversationId: id, messages: null, notOnPage: true }); return; }
      // Messages hydrate after the route settles: wait for the count to hold steady.
      for (let i = 0, last = -1; i < 16; i++) {
        const count = conversationNodes().length;
        if (count && count === last) break;
        last = count;
        await sleep(500);
      }
      // Long conversations may load earlier turns only when scrolled to.
      const scroller = (node => { for (; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node; })(conversationNodes()[0]);
      if (scroller) {
        const from = scroller.scrollTop;
        for (let i = 0, last = conversationNodes().length; i < 12; i++) {
          scroller.scrollTop = 0;
          await sleep(400);
          const count = conversationNodes().length;
          if (count === last) break;
          last = count;
        }
        if (!active) scroller.scrollTop = from;
      }
      const here = location.pathname.endsWith('/c/' + id);
      emit({ type: 'transcript', conversationId: id, messages: !active && here ? conversationMessages() : null });
    },
    async listConversations(offset = 0) {
      const start = Math.max(0, Math.floor(Number(offset)) || 0);
      try {
        const data = await settled(token => readJSON(`/backend-api/conversations?offset=${start}&limit=100&order=updated`, token));
        const items = (Array.isArray(data?.items) ? data.items : []).filter(item => typeof item?.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(item.id))
          .map(item => ({ id: item.id, title: String(item.title || '').slice(0, 200), updated: Date.parse(item.update_time) || (Number(item.update_time) * 1000) || 0 }));
        emit({ type: 'conversations', items, offset: start, total: Number(data?.total) || items.length });
      } catch (error) { emit({ type: 'conversations', items: [], offset: start, total: 0, error: 'unavailable', reason: String(error?.message || '').slice(0, 80) }); }
    },
    async openConversation(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('invalid_id');
      await window.__qchat.stop();
      media.clear(); cancelledAttachments = null; downloadActivation = null;
      await status();
      if (!loginCache) return window.__qchat.newChat();
      const path = '/c/' + id;
      if (location.pathname === path) { await status(); return; }
      history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(1500);
      if (location.pathname !== path || !find('composer')) { location.assign(path); return; }
      await sleep(300); await status();
    },
    async listModels(chooseId) {
      let switcher, opened = false;
      const unavailable = () => { if (chooseId === undefined) emit({type:'models',models:[],error:'unavailable'}); };
      const click = node => { for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) node.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type,{bubbles:true,cancelable:true,button:0})); };
      try {
        if(active) { unavailable(); return; }
        let candidates = [...document.querySelectorAll('[data-testid*="model-switcher"], button[aria-label="Select ChatGPT model"]')];
        if(!candidates.length) candidates = [...document.querySelectorAll('header [aria-haspopup]')].filter(node => /model|chatgpt|gpt/i.test((node.textContent||'')+(node.getAttribute('aria-label')||'')));
        if(candidates.length !== 1) { unavailable(); return; }
        switcher=candidates[0];
        const previous = new Set(document.querySelectorAll('[role="menu"]'));
        if(switcher.getAttribute('aria-expanded') !== 'true') {
          // The signed-in switcher opens from the keyboard; synthetic pointer events are ignored there.
          switcher.focus?.();
          switcher.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
          await sleep(120);
          if(switcher.getAttribute('aria-expanded') !== 'true') click(switcher);
        }
        opened=true;
        let nodes=[];
        for(let i=0;i<30;i++) {
          const controlled=document.getElementById(switcher.getAttribute('aria-controls'));
          const menus=[...document.querySelectorAll('[role="menu"]')].filter(n=>!previous.has(n));
          const menu=controlled || (menus.length===1 ? menus[0] : null);
          const radios=menu ? [...menu.querySelectorAll('[role="menuitemradio"]')] : [];
          nodes=radios.length ? radios : menu ? [...menu.querySelectorAll('[role="menuitem"],[role="option"]')] : [];
          if(nodes.length) break;
          await sleep(50);
        }
        if(!nodes.length) { unavailable(); return; }
        const models=nodes.map(node=>{const text=(node.innerText||node.textContent||'').trim();return {id:text,label:text.split('\n')[0].trim(),selected:node.getAttribute('aria-checked')==='true'};});
        if(chooseId !== undefined) {
          const matches=models.map((m,i)=>m.id===chooseId ? i : -1).filter(i=>i>=0);
          if(matches.length===1) {click(nodes[matches[0]]);emit({type:'model-chosen',model:models[matches[0]]});}
        } else emit({type:'models',models});
      } catch(_) { unavailable(); }
      finally {if(opened && switcher?.getAttribute('aria-expanded') === 'true') (document.activeElement || switcher).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));}
    },
    async chooseModel(id) { return window.__qchat.listModels(id); },
    async newChat(options = {}) {
      if (options.temporary) { await window.__qchat.stop(); media.clear(); location.assign('https://chatgpt.com/?temporary-chat=true'); return; }
      await window.__qchat.stop();
      media.clear(); cancelledAttachments = null; downloadActivation = null;
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
    if (block && block[1] !== lastBlock) { lastBlock = block[1]; if (active) fail(active, ...block); else error(undefined, ...block); status(); }
    if (!block) lastBlock = '';
  }, 500);
})();




