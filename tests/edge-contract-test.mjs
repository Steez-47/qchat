// Static contracts between the front end and the Rust side. No browser or build: each mismatch here
// would otherwise only show up as a silent failure in the shipped app, where the mock can't catch it.
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { read, root, suite } from './lib/check.mjs';

const { test, finish } = suite();
const uiScripts = readdirSync(path.join(root, 'ui')).filter((f) => f.endsWith('.js'));
const rustFiles = readdirSync(path.join(root, 'src-tauri/src')).filter((f) => f.endsWith('.rs'));
const rust = rustFiles.map((f) => read(`src-tauri/src/${f}`)).join('\n');
const buildRs = read('src-tauri/build.rs');
const mainRs = read('src-tauri/src/main.rs');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const capability = (name) => JSON.parse(read(`src-tauri/capabilities/${name}.json`));
const htmlFiles = ['index.html', 'settings.html'];

const scriptsOf = (html) => [...read(`ui/${html}`).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
// A name built at run time ("get_" + command) is expanded below, as settings.js builds it.
const invokedBy = (file) => {
  const source = read(`ui/${file}`);
  const fixed = [...source.matchAll(/\binvoke\(\s*(?:[^"'`)]*\?\s*)?["'`]([a-z_]+)["'`](?!\s*\+)/g)].map((m) => m[1]).filter((c) => !/_$/.test(c));
  if (!/"get_" \+ command/.test(source)) return fixed;
  const built = [.../const command = [^;]*;/.exec(source)[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== 'selection');
  assert.deepEqual(built, ['selection_hotkey', 'hotkey']);
  return [...fixed, ...built.flatMap((c) => [`get_${c}`, `set_${c}`, `get_${c}_available`])];
};
const handlers = () => {
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(mainRs)[1];
  return list.split(',').map((s) => s.trim().split('::').pop()).filter(Boolean);
};
const manifest = () => {
  const list = /\.commands\(&\[([\s\S]*?)\]\)/.exec(buildRs)[1];
  return [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};
const kebab = (command) => `allow-${command.replaceAll('_', '-')}`;
// Permissions a window is granted, from its capability file and any added at startup.
const granted = (window) => {
  const out = new Set();
  for (const name of ['main', 'settings', 'bridge']) {
    const cap = capability(name);
    if (cap.windows.includes(window)) for (const p of cap.permissions) out.add(p);
  }
  for (const [, json] of mainRs.matchAll(/add_capability\(r#"(.*?)"#\)/g)) {
    const cap = JSON.parse(json);
    if (cap.windows.includes(window)) for (const p of cap.permissions) out.add(p);
  }
  return out;
};

test('every command the UI invokes has a Rust handler', () => {
  const known = new Set(handlers());
  const missing = uiScripts.filter((f) => f !== 'mock.js').flatMap((f) => invokedBy(f).filter((c) => !known.has(c)).map((c) => `${f}: ${c}`));
  assert.deepEqual(missing, []);
});

test('registered handlers and the build manifest list the same commands', () => {
  assert.deepEqual([...new Set(handlers())].sort(), [...new Set(manifest())].sort());
});

test('no handler or manifest entry is listed twice', () => {
  for (const list of [handlers(), manifest()]) assert.deepEqual(list.filter((c, i) => list.indexOf(c) !== i), []);
});

for (const [html, window] of [['index.html', 'main'], ['settings.html', 'settings']]) {
  test(`every command ${html} scripts invoke is allowed for the ${window} window`, () => {
    const perms = granted(window);
    const missing = scriptsOf(html).filter((s) => !s.startsWith('vendor/') && s !== 'mock.js')
      .flatMap((s) => invokedBy(s).filter((c) => !perms.has(kebab(c))).map((c) => `${s}: ${c}`));
    assert.deepEqual(missing, []);
  });
}

test('every app permission a capability names is a real command', () => {
  const known = new Set(manifest().map(kebab));
  const typos = ['main', 'settings', 'bridge'].flatMap((n) => capability(n).permissions.filter((p) => !p.includes(':') && !known.has(p)).map((p) => `${n}: ${p}`));
  assert.deepEqual(typos, []);
});

test('remote provider pages can only report bridge events', () => {
  const bridge = capability('bridge');
  assert.deepEqual(bridge.permissions, ['allow-bridge-event']);
  assert.equal(bridge.local, false);
  assert.deepEqual([...bridge.remote.urls].sort(), ['https://chatgpt.com/*', 'https://gemini.google.com/*']);
  for (const name of ['main', 'settings']) assert.equal(capability(name).remote, undefined, `${name} must stay local`);
});

test('the settings window cannot send chats or touch files', () => {
  const perms = granted('settings');
  for (const command of ['chat_send', 'attachment_begin', 'media_save', 'conversation_export', 'update_install', 'snapshot_capture']) {
    assert.ok(!perms.has(kebab(command)), command);
  }
});

test('every qchat:// event the UI listens for has a sender', () => {
  const sources = uiScripts.filter((f) => f !== 'mock.js').map((f) => read(`ui/${f}`)).join('\n');
  const listened = new Set([...sources.matchAll(/listen\(\s*["'`](qchat:\/\/[a-z-]+)["'`]/g)].map((m) => m[1]));
  assert.ok(listened.size > 3, 'expected to find event listeners');
  const missing = [...listened].filter((event) => !rust.includes(`"${event}"`) && !new RegExp(`emit[A-Za-z]*\\(\\s*["'\`]${event}["'\`]`).test(sources));
  assert.deepEqual(missing, []);
});

test('versions agree across every manifest', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(conf.version, version, 'tauri.conf.json');
  assert.equal(/^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))[1], version, 'Cargo.toml');
  const lock = /name = "qchat"\s*\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'));
  assert.equal(lock?.[1], version, 'Cargo.lock');
  if (existsSync(path.join(root, 'package-lock.json'))) assert.equal(JSON.parse(read('package-lock.json')).version, version, 'package-lock.json');
});

test('the shipped script policy stays strict', () => {
  const csp = conf.app.security.csp;
  const directive = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) || '';
  assert.equal(directive('script-src'), "script-src 'self'");
  assert.equal(directive('default-src'), "default-src 'self'");
  assert.ok(!csp.includes('unsafe-eval'));
  for (const source of directive('connect-src').split(' ').slice(1)) {
    assert.match(source, /^(ipc:|http:\/\/[a-z-]+\.localhost)$/, `connect-src ${source}`);
  }
  for (const source of directive('img-src').split(' ').slice(1)) {
    assert.ok(!/^(\*|https?:)$/.test(source), `img-src ${source} is a wildcard`);
  }
});

test('the test server keeps the same script rule as the shipped policy', () => {
  const harness = read('tests/lib/ui-harness.mjs');
  assert.match(harness, /script-src 'self';/);
  assert.ok(!/script-src[^;]*unsafe/.test(harness));
});

for (const html of htmlFiles) {
  test(`${html} works under the script policy`, () => {
    const source = read(`ui/${html}`);
    assert.deepEqual(source.match(/<script\b(?![^>]*\bsrc=)[^>]*>/g) || [], [], 'inline script');
    assert.deepEqual(source.match(/\son[a-z]+\s*=\s*["']/gi) || [], [], 'inline event handler');
    assert.deepEqual([...source.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]), [], 'remote resource');
    for (const [, file] of source.matchAll(/\b(?:src|href)="([^"#:]+\.(?:js|css))"/g)) assert.ok(existsSync(path.join(root, 'ui', file)), `${html} references missing ${file}`);
  });
  test(`${html} has no duplicate ids`, () => {
    const ids = [...read(`ui/${html}`).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });
}

test('the app never turns strings into code', () => {
  const offenders = uiScripts.filter((f) => /(^|[^.\w])eval\(|new Function\(|\.insertAdjacentHTML\(\s*["'`]beforebegin["'`],\s*location/.test(read(`ui/${f}`)));
  assert.deepEqual(offenders, []);
});

test('every id the scripts look up exists or is created by a script', () => {
  const missing = [];
  for (const [html, window] of [['index.html', 'main'], ['settings.html', 'settings']]) {
    const sources = scriptsOf(html).filter((s) => !s.startsWith('vendor/') && s !== 'mock.js');
    const text = sources.map((s) => read(`ui/${s}`)).join('\n');
    const known = new Set([...read(`ui/${html}`).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    // Scripts may build a node with this id, in a template or by assigning `.id`.
    const created = (id) => text.includes(`id="${id}"`) || text.includes(`id=\\"${id}\\"`) || new RegExp(`\\.id\\s*=\\s*["'\`]${id}["'\`]`).test(text) || new RegExp(`["'\`]?id["'\`]?\\s*:\\s*["'\`]${id}["'\`]`).test(text);
    for (const [, id] of text.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g)) {
      if (!known.has(id) && !created(id)) missing.push(`${window}: ${id}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('every front-end script parses', () => {
  for (const file of [...uiScripts.map((f) => `ui/${f}`), ...readdirSync(path.join(root, 'src-tauri/bridge')).filter((f) => f.endsWith('.js')).map((f) => `src-tauri/bridge/${f}`)]) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file);
  }
});

test('every CSS variable used without a fallback is defined somewhere', () => {
  const css = ['app.css', 'glass.css', 'settings.css'].map((f) => read(`ui/${f}`)).join('\n');
  const scripts = uiScripts.map((f) => read(`ui/${f}`)).join('\n');
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
  // Timing tokens are written in a loop over BASE_MS (css[`--${key}`]) rather than by name.
  const timings = Object.keys(new Function(`return ${/const BASE_MS = (\{[^}]*\})/.exec(read('ui/settings-core.js'))[1]}`)()).map((key) => `--${key}`);
  const defined = (name) => new RegExp(`${name}\\s*:`).test(css) || scripts.includes(name) || scripts.includes(`"${name.slice(2)}"`) || timings.includes(name);
  assert.deepEqual([...used].filter((name) => !defined(name)), []);
});

await finish();
