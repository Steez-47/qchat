// Read-only probe for the Chat/Work (ChatGPT) and Chat/Task (Gemini) switches.
// Point QCHAT_MODE_DEBUG_PORT at an already running hidden test instance. It
// never launches, copies a profile, clicks, types or navigates; it only lists
// the controls the bridge selectors would consider, plus why each is excluded.
const port = process.env.QCHAT_MODE_DEBUG_PORT;
const providers = [
  { name: 'chatgpt', host: 'chatgpt.com', work: '^work$', chat: '^chat$' },
  { name: 'gemini', host: 'gemini.google.com', work: '^(?:spark|tasks?|agent)$', chat: '^chat$' }
];

if (!port || !/^\d+$/.test(port)) {
  console.error('LIVE LIMIT: Set QCHAT_MODE_DEBUG_PORT for an existing hidden test instance. No profile copy or launch attempted.');
  process.exitCode = 1;
} else {
  const inspect = ({ work, chat }) => `(() => {
    const modeSelector = '[role="tab"], [role="radio"], [role="menuitemradio"], button, a[role]';
    const modeExcluded = '[data-message-author-role], [data-message-role], user-query, model-response, nav a[href*="/c/"], [data-testid^="history-item"], conversations-list, .conversation, [contenteditable="true"]';
    const shown = node => !!node && node.isConnected !== false && !!node.getClientRects?.().length && !node.closest?.('[hidden], [aria-hidden="true"]');
    const name = node => {
      const text = String(node.innerText ?? node.textContent ?? '').split('\\n').map(line => line.trim()).find(Boolean) || '';
      const label = String(node.getAttribute?.('aria-label') || '').split('\\n')[0].trim();
      return { text, label };
    };
    const work = new RegExp(${JSON.stringify(work)}, 'i'), chat = new RegExp(${JSON.stringify(chat)}, 'i');
    const describe = node => {
      const { text, label } = name(node);
      const excluded = !!node.closest?.(modeExcluded);
      const exact = work.test(text) || work.test(label) ? 'work' : chat.test(text) || chat.test(label) ? 'chat' : null;
      return {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        text: text.slice(0, 120),
        label: label.slice(0, 120),
        testid: node.getAttribute('data-testid') || node.getAttribute('data-test-id') || null,
        aria: {
          selected: node.getAttribute('aria-selected'),
          checked: node.getAttribute('aria-checked'),
          current: node.getAttribute('aria-current'),
          expanded: node.getAttribute('aria-expanded'),
          pressed: node.getAttribute('aria-pressed'),
          controls: node.getAttribute('aria-controls'),
          disabled: node.getAttribute('aria-disabled')
        },
        dataState: node.getAttribute('data-state'),
        disabled: !!node.disabled,
        visible: shown(node),
        excluded,
        exact,
        bridgeCandidate: shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && !excluded && !!exact
      };
    };
    const matches = [...document.querySelectorAll(modeSelector)].filter(node => {
      const { text, label } = name(node);
      return work.test(text) || work.test(label) || chat.test(text) || chat.test(label);
    }).map(describe);
    return {
      origin: location.origin,
      pathname: location.pathname,
      visible: matches.filter(node => node.visible),
      hidden: matches.filter(node => !node.visible)
    };
  })()`;

  const evaluate = (page, expression) => new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(Error('Probe timed out')); }, 15000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression } }));
    socket.onerror = () => { clearTimeout(timer); reject(Error('Could not connect to the page')); };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) reject(Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    };
  });

  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const results = [];
    for (const provider of providers) {
      const page = pages.find(candidate => {
        try { return new URL(candidate.url).hostname === provider.host; } catch { return false; }
      });
      if (!page) {
        results.push({ provider: provider.name, error: `No ${provider.host} page in supplied test instance` });
        process.exitCode = 1;
        continue;
      }
      try {
        results.push({ provider: provider.name, page: await evaluate(page, inspect(provider)) });
      } catch (error) {
        results.push({ provider: provider.name, error: error.message });
        process.exitCode = 1;
      }
    }
    console.log(JSON.stringify(results));
  } catch (error) {
    console.error('LIVE LIMIT: ' + error.message);
    process.exitCode = 1;
  }
}
