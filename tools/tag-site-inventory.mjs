// Public-site component-name inventory for response markup research.
// Uses a disposable headless Edge profile and an unauthenticated guest visit to
// chatgpt.com. Records script URLs, byte counts and string-hit counts only: no
// account, no conversation content, no bundle is written to disk. Bounded to
// 12 scripts / 30 MiB / 100 s so it cannot become a crawler.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MAX_SCRIPTS = 12;
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_MS = 100000;
const started = Date.now();
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-tag-inventory-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exact, case-sensitive literals only. These are the names QChat already renders
// plus generic HTML/layout names; a hit means the string exists in a public asset.
const NAMES = [
  'AsyncImageGroup', 'AsyncImage', 'Entity', 'Cite', 'grid-item',
  'navlist', 'image_search_query', 'opGenui', 'componentResults',
  'data-d-component', 'data-markdown-copy', 'data-dil-message-id'
];

const browser = spawn(EDGE, [
  '--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore', windowsHide: true });

let ws;
const out = { site: 'https://chatgpt.com/', fetchedAt: new Date().toISOString(), scripts: [], hits: {}, limitations: [] };
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error('Headless Edge did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); resolve({error:'CDP timeout'}); }, 10000);
    pending.set(id, result => { clearTimeout(timeout); resolve(result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'https://chatgpt.com/' });
  // Guest landing either loads or redirects to auth; either way the shell's
  // public assets are what we inventory.
  for (let i = 0; i < 40; i++) { await sleep(500); if (Date.now() - started > 30000) break; }
  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      title: document.title,
      build: [...document.querySelectorAll('meta')].map(m => m.getAttribute('content') || '').find(v => /^[0-9a-f]{6,}$/i.test(v)) || null,
      scripts: performance.getEntriesByType('resource').map(e => e.name).filter(n => /\\.js(\\?|$)/.test(n)),
      inline: [...document.scripts].filter(s => !s.src && s.textContent.length > 1000).length
    })`, returnByValue: true
  });
  const page = JSON.parse(probe.result?.result?.value || '{}');
  out.page = { url: page.url, title: page.title, build: page.build, scriptCount: page.scripts?.length || 0, inlineScripts: page.inline || 0 };
  if (!page.scripts?.length) throw new Error('No script URLs observed');
  const urls = [...new Set(page.scripts)].filter((u) => /^https:\/\/[^/]*oaistatic\.com\//.test(u)).slice(0, MAX_SCRIPTS);
  out.scripts = urls;
  if (!urls.length) out.limitations.push(/Just a moment/i.test(page.title) ? 'Cloudflare guest challenge; no application bundles available' : 'No public oaistatic bundles available');
  let bytes = 0;
  for (const url of urls) {
    if (bytes >= MAX_BYTES || Date.now() - started > MAX_TOTAL_MS) { out.limitations.push('byte/time cap reached'); break; }
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 QChat tag inventory' }, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, MAX_TOTAL_MS - (Date.now() - started)))) });
    if (!res.ok) { out.limitations.push(`HTTP ${res.status} for ${url}`); continue; }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let text = '';
    while (bytes < MAX_BYTES) {
      const chunk = await reader.read(); if (chunk.done) break;
      const accepted = chunk.value.subarray(0, MAX_BYTES - bytes);
      bytes += accepted.byteLength; text += decoder.decode(accepted, {stream:true});
    }
    await reader.cancel();
    const found = NAMES.filter((name) => text.includes(name));
    out.hits[url.split('/').pop()] = found;
  }
  out.bytesScanned = bytes;
} catch (error) {
  out.error = String(error?.message || error);
} finally {
  try { ws?.close(); } catch {}
  try { browser.kill(); } catch {}
  await sleep(300);
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-tag-inventory-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
out.elapsedMs = Date.now() - started;
console.log(JSON.stringify(out, null, 2));
