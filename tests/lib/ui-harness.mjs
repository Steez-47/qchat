// Shared plumbing for the UI suites: the static server for ui/, an isolated headless browser page
// and the DevTools connection. Mock backend only: no account, no site access, no OS-level input.
//
// Under tests/run.mjs every suite gets its own private browser context in one shared browser, which
// is far quicker than starting a browser per suite. Run on its own, a suite starts its own browser.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };

const BROWSER_FLAGS = ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];
export const browserPath = () => process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// Serves ui/ with the production script policy, so inline scripts fail here as they do in the app.
// `onRequest` and `onMissing` report each path asked for and each one that wasn't there.
//
// `/__blank` is an empty page on the same origin, so a suite can seed localStorage without loading
// the whole app first. Files may be cached, because they can't change during a suite.
export async function serveUI({ csp = CSP, onRequest, onMissing } = {}) {
  const server = createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/__blank') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>'); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    onRequest?.(relative);
    if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { onMissing?.(relative); res.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(path.join(root, 'ui', relative));
      res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
      if (csp) res.setHeader('Content-Security-Policy', csp);
      if (relative !== 'index.html' && relative !== 'settings.html') res.setHeader('Cache-Control', 'max-age=3600');
      res.end(bytes);
    } catch { onMissing?.(relative); res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close() { server.close(); server.closeAllConnections(); }
  };
}

// Starts a headless browser on a throwaway profile. Used by the runner and by standalone suites.
export async function launchBrowser(label = 'browser') {
  const profile = await mkdtemp(path.join(tmpdir(), `qchat-${label}-`));
  const child = spawn(browserPath(), [...BROWSER_FLAGS, ...(process.platform === 'win32' ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // Keep the end of the browser's own complaints, so a failed start says why.
  let stderr = '', exited = null;
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.on('exit', (code, signal) => { exited = signal || code; });
  child.on('error', (error) => { exited = error.message; });
  const kill = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  };
  // A suite that throws or is killed must not leave a browser or a profile behind.
  const onExit = () => { kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  process.once('exit', onExit);
  // A cold first start on a fresh CI runner can take far longer than a warm one.
  let port;
  const deadline = Date.now() + 30000;
  while (!port && exited === null && Date.now() < deadline) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await sleep(25);
  }
  if (!port) {
    kill();
    const why = exited !== null ? `exited (${exited})` : 'gave no DevTools port within 30 seconds';
    throw new Error(`Headless browser did not start: ${browserPath()} ${why}${stderr.trim() ? `\n${stderr.trim().split('\n').slice(-15).join('\n')}` : ''}`);
  }
  child.stderr.resume(); child.stderr.removeAllListeners('data');
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      process.removeListener('exit', onExit);
      kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  };
}

// Commands over one DevTools websocket. Runtime errors and console errors land in `problems`.
export function devtools(ws, { problems = [], timeout = 60000, logEntries = true, onEvent } = {}) {
  let serial = 0;
  const pending = new Map();
  ws.onclose = () => { for (const done of pending.values()) done({ error: { message: 'CDP closed' } }); pending.clear(); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (logEntries && m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) problems.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
    onEvent?.(m);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(id, (d) => { clearTimeout(timer); if (d.error) reject(new Error(`${method}: ${d.error.message}`)); else resolve(d.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description}`);
    return result.result.value;
  };
  return { cdp, evalJS };
}

// The app's long timers (first update check, model and open timeouts, auto-dismiss) are what suites
// spend most of their time waiting for. On a test page, a timer of three seconds or more fires ten times
// sooner. Short timers and animations keep real time. `npm test -- --realtime` turns this off, and
// a suite that measures a long timer itself opts out with `{ realTimers: true }`.
export const fastTimers = !process.env.QCHAT_TEST_REALTIME;
// A wait in a suite that has to outlast one of those long timers.
export const timerMs = (ms) => (fastTimers ? ms / 10 : ms);
const FAST_TIMERS = `(() => {
  window.__QCHAT_MOCK_INTERVAL__ = 8;
  const real = window.setTimeout;
  window.setTimeout = function (fn, ms, ...args) { return real(fn, ms >= 3000 ? Math.max(300, ms / 10) : ms, ...args); };
})();`;

const connect = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`Could not connect to ${url}`)); });
  return ws;
};

// One isolated page. `connect()` returns the page's devtools commands; `close()` removes the page
// and all of its storage. Standalone runs start and stop their own browser around it.
export async function openPage(label, { problems = [], onEvent, timeout, logEntries, realTimers = false } = {}) {
  const own = process.env.QCHAT_TEST_BROWSER ? null : await launchBrowser(label);
  const origin = process.env.QCHAT_TEST_BROWSER || own.origin;
  const version = await (await fetch(`${origin}/json/version`)).json();
  const browserWs = await connect(version.webSocketDebuggerUrl);
  const browser = devtools(browserWs);
  const { browserContextId } = await browser.cdp('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browser.cdp('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true });
  const ws = await connect(`${origin.replace('http', 'ws')}/devtools/page/${targetId}`);
  const page = devtools(ws, { problems, onEvent, timeout, logEntries });
  // Each page acts as the focused window, whichever window the shared browser has in front.
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (!realTimers && fastTimers) await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAST_TIMERS });
  return {
    ...page,
    ws,
    async close() {
      ws.close();
      await browser.cdp('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      browserWs.close();
      await own?.close();
    }
  };
}
