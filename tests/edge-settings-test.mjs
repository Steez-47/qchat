// Edge cases for saved settings: hostile values, corrupted or missing storage, old versions and
// presets. Plain Node: settings-core.js runs in a small DOM stand-in.
import assert from 'node:assert/strict';
import { loadUI, memoryStorage, plain, random, runs, suite } from './lib/check.mjs';

const { test, finish } = suite();

function boot(initial = {}, { search = '', storage = memoryStorage(initial), screen = { availWidth: 2560, availHeight: 1440 } } = {}) {
  const style = { setProperty() {}, removeProperty() {} };
  const element = { style, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, removeAttribute() {} };
  const document = { documentElement: element, body: element, querySelector: () => null, getElementById: () => null, createElement: () => ({ ...element }), head: { append() {}, appendChild() {} } };
  const { window } = loadUI(['settings-core.js'], {
    document,
    localStorage: storage,
    location: { search },
    URLSearchParams,
    window: { document, screen, matchMedia: () => ({ matches: false, addEventListener() {} }), __QCHAT_MOCK__: true, localStorage: storage, location: { search } },
    screen,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 0
  });
  return { S: window.QSettings, storage };
}

const { S } = boot();
const SETTINGS = { 'qchat.settings': (value) => JSON.stringify(value) };
const HOSTILE = [undefined, null, NaN, Infinity, -Infinity, -0, 1e308, -1e308, 0, 1, -1, 0.1, '', ' ', 'x', '5', '  5  ', '0x10', '1e3', 'NaN', 'Infinity', true, false, [], [1], {}, { valueOf: () => 5 }, () => 5, Symbol.iterator, 10n, new Date(0), /x/, '<script>', '__proto__', 'a'.repeat(100000), '\u0000\u001f\u007f', '😀'];

test('every schema entry can hold its own default', () => {
  for (const [key, spec] of Object.entries(S.SCHEMA)) {
    assert.deepEqual(S.sanitizeValue(key, spec.def), spec.def, key);
    if (spec.type === 'range') {
      assert.ok(spec.min < spec.max && spec.step > 0, key);
      assert.ok(spec.def >= spec.min && spec.def <= spec.max, key);
    }
    if (spec.type === 'enum') assert.ok(spec.options.includes(spec.def), key);
  }
});

test('sanitize always gives a value of the right type, whatever is stored', () => {
  for (const [key, spec] of Object.entries(S.SCHEMA)) {
    for (const value of HOSTILE) {
      let out;
      assert.doesNotThrow(() => { out = S.sanitizeValue(key, value); }, `${key} = ${String(typeof value)}`);
      switch (spec.type) {
        case 'range':
          assert.ok(typeof out === 'number' && Number.isFinite(out) && out >= spec.min - 1e-9 && out <= spec.max + 1e-9, `${key}: ${out}`);
          assert.ok(!Object.is(out, -0) || spec.min < 0, `${key} produced -0`);
          break;
        case 'enum': assert.ok(spec.options.includes(out), `${key}: ${out}`); break;
        case 'bool': assert.equal(typeof out, 'boolean', key); break;
        case 'text':
          assert.equal(typeof out, 'string', key);
          assert.ok(out.length <= spec.max, key);
          assert.doesNotMatch(out, /[\x00-\x1f\x7f]/, key);
          break;
        case 'color': assert.match(out, /^#[0-9A-F]{6}$/, key); break;
        default: assert.fail(`unknown type for ${key}`);
      }
    }
  }
});

test('ranges snap to their steps without float noise', () => {
  for (const [key, spec] of Object.entries(S.SCHEMA)) {
    if (spec.type !== 'range') continue;
    const r = random(key.length);
    for (let i = 0; i < runs(200); i++) {
      const out = S.sanitizeValue(key, spec.min - spec.step + r.next() * (spec.max - spec.min + 2 * spec.step));
      const steps = (out - spec.min) / spec.step;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${key}: ${out} is off its ${spec.step} step`);
      assert.ok(String(out).length < 10, `${key}: ${out} has float noise`);
    }
    assert.equal(S.sanitizeValue(key, spec.min - 1000), spec.min, key);
    assert.ok(Math.abs(S.sanitizeValue(key, spec.max + 1000) - spec.max) < spec.step, key);
  }
});

test('sanitize is idempotent and only ever returns schema keys', () => {
  const keys = Object.keys(S.SCHEMA).sort();
  const r = random(21);
  for (let i = 0; i < runs(800); i++) {
    const raw = {};
    for (const key of keys) if (r.next() < 0.5) raw[key] = r.pick(HOSTILE);
    raw.notASetting = 'x';
    const once = S.sanitize(raw);
    assert.deepEqual(Object.keys(once).sort(), keys);
    assert.deepEqual(plain(S.sanitize(once)), plain(once));
  }
  for (const junk of [null, undefined, 5, 'x', [], [1, 2], true, () => {}]) assert.deepEqual(plain(S.sanitize(junk)), plain(S.sanitize({})));
});

test('saved JSON cannot pollute prototypes', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"look":"nord"}');
  const out = S.sanitize(raw);
  assert.equal(out.look, 'nord');
  assert.equal(out.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(S.sanitizeValue('__proto__', 1), undefined);
  assert.equal(S.sanitizeValue('constructor', 1), undefined);
  assert.equal(S.sanitizeValue('toString', 1), undefined);
});

test('corrupted storage falls back to clean defaults', () => {
  for (const stored of ['', '{', 'null', '[]', '5', '"text"', 'true', '{"v":"junk"}', '{"v":null}', '{"v":{}}', '\u0000', 'undefined', '[{}]']) {
    const { S: fresh } = boot({ 'qchat.settings': stored });
    const loaded = plain(fresh.load());
    assert.deepEqual(Object.keys(loaded).sort(), Object.keys(fresh.SCHEMA).sort(), stored);
    for (const [key, spec] of Object.entries(fresh.SCHEMA)) if (spec.type === 'enum') assert.ok(spec.options.includes(loaded[key]), `${stored}: ${key}`);
  }
});

test('storage that refuses reads or writes never stops settings working', () => {
  for (const flag of ['failWrites', 'failAll']) {
    const storage = memoryStorage();
    storage[flag] = true;
    const { S: fresh } = boot({}, { storage });
    assert.doesNotThrow(() => fresh.load(), flag);
    const saved = plain(fresh.save({ ...fresh.DEFAULTS, look: 'nord' }));
    assert.equal(saved.look, 'nord', flag);
    assert.equal(fresh.savePreset('Mine', fresh.DEFAULTS), null, flag);
    assert.equal(fresh.deletePreset('x'), false, flag);
    assert.deepEqual(plain(fresh.listPresets()), [], flag);
  }
});

test('old saved settings upgrade once, and keep what the user chose', () => {
  const saved = (value) => ({ 'qchat.settings': SETTINGS['qchat.settings'](value) });
  const v0 = boot(saved({ look: 'nord', glassOpacity: 33, streamStyle: 'fade', feel: 'springy', textSize: 14, lineHeight: 1.6, blur: 12, replyOpacity: 10 }));
  const a = plain(v0.S.load());
  assert.equal(a.look, 'nord', 'an unrelated choice is kept');
  assert.equal(a.glassOpacity, v0.S.DEFAULTS.glassOpacity, 'glass is reset before v2');
  assert.equal(a.streamStyle, 'paragraph', 'the old fade default moves to paragraph');
  assert.equal(a.feel, 'calm');
  assert.equal(a.lineHeight, 1.65);
  assert.equal(a.replyOpacity, v0.S.DEFAULTS.replyOpacity);

  const current = boot(saved({ v: v0.S.VERSION, look: 'nord', glassOpacity: 33, streamStyle: 'fade', feel: 'springy' }));
  const b = plain(current.S.load());
  assert.equal(b.glassOpacity, 33, 'a current file is not reset');
  assert.equal(b.streamStyle, 'fade');
  assert.equal(b.feel, 'springy');

  const upgraded = JSON.parse(v0.storage.getItem('qchat.settings'));
  assert.equal(upgraded.v, v0.S.VERSION, 'the upgrade is saved');
  assert.deepEqual(plain(boot({ 'qchat.settings': JSON.stringify(upgraded) }).S.load()), a, 'loading again changes nothing');

  const future = boot(saved({ v: 999, look: 'nord', madeUp: 1 })).S.load();
  assert.equal(future.look, 'nord', 'a newer file still loads');
  assert.equal(future.madeUp, undefined);
});

test('the legacy look key survives junk', () => {
  for (const legacy of ['{', 'null', '5', '{"glass":"x"}', '{"look":"nosuch","glass":9}']) {
    const { S: fresh } = boot({ 'qchat.look': legacy });
    const out = plain(fresh.load());
    assert.ok(Object.hasOwn(fresh.LOOKS, out.look), legacy);
    assert.ok(out.glassOpacity >= 20 && out.glassOpacity <= 100, legacy);
  }
  assert.equal(plain(boot({ 'qchat.look': '{"look":"nord","glass":0.5}' }).S.load()).glassOpacity, 50);
});

test('every look is complete', () => {
  const hex = /^#[0-9A-F]{6}$/i;
  for (const [id, look] of Object.entries(S.LOOKS)) {
    assert.equal(typeof look.label, 'string', id);
    assert.ok(['auto', 'dark', 'light'].includes(look.scheme), id);
    if (id === 'system') continue;
    assert.equal(look.tint.length, 2, id);
    assert.equal(look.accent.length, 3, id);
    assert.equal(look.orb.length, 3, id);
    for (const color of [...look.tint, ...look.accent, ...look.orb, look.ink, look.edge, look.accentText, look.critical, look.criticalText]) assert.match(color, hex, id);
  }
});

test('built-in presets only hold valid values for appearance settings', () => {
  const ids = S.PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const preset of S.PRESETS) {
    for (const [key, value] of Object.entries(preset.values)) {
      assert.ok(S.APPEARANCE_KEYS.includes(key), `${preset.id}.${key} is not an appearance setting`);
      assert.deepEqual(S.sanitizeValue(key, value), value, `${preset.id}.${key}`);
    }
  }
});

test('applying a preset keeps behaviour settings', () => {
  const mine = { ...S.DEFAULTS, idleCollapse: 12, sendKey: 'ctrl', keepHistory: false, alwaysOnTop: false, defaultProvider: 'gemini' };
  for (const preset of S.PRESETS) {
    const out = S.applyPreset(mine, preset.id);
    for (const key of ['idleCollapse', 'sendKey', 'keepHistory', 'alwaysOnTop', 'defaultProvider']) assert.equal(out[key], mine[key], `${preset.id}: ${key}`);
  }
  assert.deepEqual(plain(S.applyPreset(mine, 'nosuch')), plain(S.sanitize(mine)), 'an unknown preset changes nothing');
  assert.deepEqual(plain(S.applyPreset(mine, '__proto__')), plain(S.sanitize(mine)));
});

test('saved presets refuse junk, trim labels and stop at the limit', () => {
  const { S: fresh } = boot();
  for (const label of ['', '   ', null, undefined, 5, {}, []]) assert.equal(fresh.savePreset(label, fresh.DEFAULTS), null, String(label));
  const saved = fresh.savePreset(`  ${'L'.repeat(200)}  `, { ...fresh.DEFAULTS, idleCollapse: 33 });
  assert.equal(saved.label.length, 60);
  assert.equal(saved.values.idleCollapse, undefined, 'presets only hold appearance');
  for (let i = 1; i < 40; i++) assert.ok(fresh.savePreset(`p${i}`, fresh.DEFAULTS), `preset ${i}`);
  assert.equal(fresh.listPresets().length, 40);
  assert.equal(fresh.savePreset('one too many', fresh.DEFAULTS), null);
  assert.equal(fresh.listPresets().length, 40);
  assert.equal(new Set(fresh.listPresets().map((p) => p.id)).size, 40, 'ids stay unique');
  assert.ok(fresh.deletePreset(saved.id));
  assert.ok(!fresh.listPresets().some((p) => p.id === saved.id));
  assert.equal(fresh.deletePreset('nosuch'), true, 'deleting nothing is harmless');
  assert.equal(fresh.listPresets().length, 39);
});

test('imported presets refuse junk and drop anything unknown', () => {
  const { S: fresh } = boot();
  for (const json of ['', '{', 'null', '5', '[]', '"x"', '{"label":"x"}', '{"values":{}}', '{"label":5,"values":{}}', '{"label":"x","values":[]}', '{"label":"x","values":null}', '{"label":"   ","values":{}}']) {
    assert.equal(fresh.importPreset(json), null, json);
  }
  const imported = fresh.importPreset('{"label":"Hostile","values":{"look":"nosuch","textSize":9999,"idleCollapse":1,"__proto__":{"polluted":1},"madeUp":1}}');
  assert.ok(imported);
  assert.ok(imported.values.textSize <= fresh.SCHEMA.textSize.max);
  assert.equal(imported.values.madeUp, undefined);
  assert.equal(imported.values.idleCollapse, undefined);
  assert.equal(({}).polluted, undefined);
  const again = fresh.importPreset(fresh.exportPreset(imported.id));
  assert.deepEqual(plain(again.values), plain(imported.values), 'export and import round trip');
  assert.equal(fresh.exportPreset('nosuch'), '');
});

test('a tampered preset list loads only its valid entries', () => {
  const list = JSON.stringify([null, 5, 'x', [], {}, { id: 5, label: 'x', values: {} }, { id: 'a', label: 5, values: {} }, { id: 'b', label: 'x' }, { id: 'c', label: 'x', values: [] }, { id: 'd', label: '   ', values: { textSize: 9999, madeUp: 1 } }]);
  const out = plain(boot({ 'qchat.presets': list }).S.listPresets());
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'My preset');
  assert.ok(out[0].values.textSize <= S.SCHEMA.textSize.max);
  assert.equal(out[0].values.madeUp, undefined);
  for (const junk of ['{', 'null', '5', '{}', '"x"']) assert.deepEqual(plain(boot({ 'qchat.presets': junk }).S.listPresets()), [], junk);
  const many = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, label: 'x', values: {} })));
  assert.equal(boot({ 'qchat.presets': many }).S.listPresets().length, 40);
});

test('screen tiers hold at their exact edges', () => {
  for (const [width, height, tier] of [[1399, 2000, 'small'], [1400, 900, 'medium'], [1400, 899, 'small'], [2199, 1300, 'medium'], [2200, 1299, 'medium'], [2200, 1300, 'large'], [1920, 1080, 'medium'], [1536, 864, 'small'], [1280, 720, 'small'], [3840, 2160, 'large'], [800, 3000, 'small']]) {
    assert.equal(S.screenTier(width, height), tier, `${width}x${height}`);
  }
  for (const [w, h] of [[0, 0], [-1, 100], [100, -1], [NaN, 100], [100, NaN], [null, null], [undefined, undefined], ['x', 5]]) assert.equal(S.screenTier(w, h), null, `${w}x${h}`);
});

test('a stored screen fit that is junk is ignored', () => {
  for (const fit of ['{', 'null', '5', '{"tier":"huge"}', '{"tier":"__proto__"}', '{"tier":"constructor"}', '{"tier":5}', '[]']) {
    const { S: fresh } = boot({ 'qchat.screenfit': fit });
    assert.ok(Object.hasOwn(fresh.FIT_SIZES, fresh.screenFit), fit);
  }
  assert.equal(boot({ 'qchat.screenfit': '{"tier":"small"}' }).S.DEFAULTS.textSize, 13, 'a valid fit is used');
  assert.equal(boot({}, { search: '?screen=1280x720' }).S.screenFit, 'small');
  for (const search of ['?screen=', '?screen=x', '?screen=0x0', '?screen=-1x5', '?screen=1280']) assert.equal(boot({}, { search }).S.screenFit, 'large', search);
});

test('upgraded sizes only move when they were never changed', () => {
  const stored = (value) => ({ 'qchat.settings': JSON.stringify(value), 'qchat.screenfit': '{"tier":"small"}' });
  const untouched = boot(stored({ v: 6, textSize: S.BASE_DEFAULTS.textSize, barWidth: S.BASE_DEFAULTS.barWidth })).S.load();
  assert.equal(untouched.textSize, 13, 'a stock size takes the screen default');
  assert.equal(untouched.barWidth, 380);
  const chosen = boot(stored({ v: 6, textSize: 19, barWidth: 700 })).S.load();
  assert.equal(chosen.textSize, 19, 'a chosen size stays');
  assert.equal(chosen.barWidth, 700);
});

await finish();
