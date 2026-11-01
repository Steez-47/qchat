// Small helpers for plain Node suites: named tests, a seeded random source and a load helper for
// the browser scripts in ui/. Output matches the UI suites: PASS/FAIL lines, then ALL PASS.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

// `QCHAT_FUZZ_SEED` replays a failure; `QCHAT_FUZZ_RUNS` multiplies the iterations for a long soak.
export const FUZZ_SEED = Number(process.env.QCHAT_FUZZ_SEED) || 0x51c4a7;
export const FUZZ_SCALE = Math.max(0.01, Number(process.env.QCHAT_FUZZ_RUNS) || 1);
export const runs = (count) => Math.max(1, Math.round(count * FUZZ_SCALE));

export function suite() {
  let failed = 0, passed = 0;
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  const finish = async () => {
    for (const [name, fn] of tests) {
      try {
        await fn();
        passed++;
        console.log(`PASS ${name}`);
      } catch (error) {
        failed++;
        console.log(`FAIL ${name} :: ${error?.stack || error}`);
      }
    }
    console.log(failed ? `${failed} FAILED` : `ALL PASS (${passed})`);
    process.exitCode = failed ? 1 : 0;
  };
  return { test, finish };
}

// Deterministic generator (mulberry32), so a failing input can be replayed from its seed.
export function random(seed = FUZZ_SEED) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max) => Math.floor(next() * max);
  const pick = (list) => list[int(list.length)];
  const text = (parts, length) => Array.from({ length: int(length) + 1 }, () => pick(parts)).join('');
  return { next, int, pick, text };
}

// Loads scripts from ui/ into one fresh browser-like context. `extra` adds or replaces globals.
export function loadUI(files, extra = {}) {
  const window = { ...extra.window };
  const context = vm.createContext({ window, URL, Intl, console, ...extra, window });
  window.window = window;
  for (const file of files) vm.runInContext(read(`ui/${file}`), context, { filename: `ui/${file}` });
  return { window, context };
}

// Copies a value out of a vm context, so strict assertions compare plain objects from this realm.
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// In-memory localStorage. `failWrites` stands for a full disk, `failAll` for storage switched off.
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    failWrites: false,
    failAll: false,
    get length() { return map.size; },
    getItem(key) { if (this.failAll) throw new Error('denied'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (this.failAll || this.failWrites) throw new Error('QuotaExceededError'); map.set(key, String(value)); },
    removeItem(key) { if (this.failAll) throw new Error('denied'); map.delete(key); },
    clear() { map.clear(); }
  };
}

// Fails when `fn` takes clearly too long. Budgets are generous on purpose: they catch runaway
// (quadratic or backtracking) behaviour without tripping on a busy machine.
export function within(ms, fn, label = 'work') {
  const started = performance.now();
  const result = fn();
  const took = performance.now() - started;
  if (took > ms) throw new Error(`${label} took ${Math.round(took)}ms, budget ${ms}ms`);
  return result;
}
