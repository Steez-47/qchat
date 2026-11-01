// Runs every offline suite in parallel: plain Node unit and bridge tests, and the headless UI suites,
// which drive ui/ against the mock backend in private contexts of one shared, invisible browser.
//
//   npm test                   all offline suites
//   npm test -- collapse       only suites whose file name contains "collapse"
//   npm test -- --fast         only the suites that need no browser
//   npm test -- --jobs 4       limit how many suites run at once (or set QCHAT_TEST_JOBS)
//   npm test -- --no-retry     report a failure at once, with no clean retry
//   npm test -- --realtime     keep the app's long timers at real speed (slower, full fidelity)
//   npm test -- --logs <dir>   keep each suite's full output in <dir>
//
// A suite that fails is run once more on its own, in its own browser. If it then passes, the run still
// passes but the suite is listed as load-sensitive, so a shaky test stays visible.
//
// The UI suites use Edge at its default Windows path. Elsewhere, point QCHAT_TEST_EDGE at a
// Chromium-based browser (on Linux, a wrapper that adds --no-sandbox when running as root).
//
// Not run here, because they need a debug build, a real window, the network or a signed-in
// profile: *-native-test, *-e2e, live-media-smoke, bridge-test (live ChatGPT) and tests/live/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/ui-harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LIVE = new Set(['bridge-test.mjs', 'live-media-smoke.mjs']);
const SUITE_TIMEOUT = Number(process.env.QCHAT_TEST_TIMEOUT) || 240000;
const TIMINGS = path.join(tmpdir(), 'qchat-test-timings.json');

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(name); if (at < 0) return false; args.splice(at, 1); return true; };
const option = (name) => { const at = args.indexOf(name); if (at < 0) return null; const [, value] = args.splice(at, 2); return value; };
const fast = flag('--fast');
const retry = !flag('--no-retry');
if (flag('--realtime')) process.env.QCHAT_TEST_REALTIME = '1';
const logs = option('--logs');
const jobs = Math.max(1, Number(option('--jobs') || process.env.QCHAT_TEST_JOBS) || Math.min(10, Math.max(3, availableParallelism() - 2)));
if (logs) mkdirSync(logs, { recursive: true });

// A suite needs the browser if it opens a page itself, directly or through the harness.
const usesBrowser = (file) => /openPage|remote-debugging-port/.test(readFileSync(path.join(dir, file), 'utf8'));
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('-test.mjs') && !f.includes('-native-') && !LIVE.has(f))
  .filter((f) => !args.length || args.some((needle) => f.includes(needle)))
  .filter((f) => !fast || !usesBrowser(f))
  .sort();
if (!suites.length) { console.error(`No suites match: ${args.join(', ')}`); process.exit(1); }

let timings = {};
try { timings = JSON.parse(readFileSync(TIMINGS, 'utf8')); } catch {}

const killTree = (child) => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
};

const run = (file, env) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(dir, file)], { cwd: path.join(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, SUITE_TIMEOUT);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) output += `\nTimed out after ${SUITE_TIMEOUT / 1000}s`;
    if (logs) writeFileSync(path.join(logs, `${file}.log`), output);
    resolve({ file, code: timedOut ? 1 : code, output, seconds: (Date.now() - started) / 1000, checks: (output.match(/^PASS /gm) || []).length });
  });
});

const started = Date.now();
const browserSuites = suites.filter(usesBrowser);
// A few shared browsers, because one browser's main thread can't serve every suite's traffic alone.
const browserCount = browserSuites.length ? Math.max(1, Number(process.env.QCHAT_TEST_BROWSERS) || Math.ceil(jobs / 4)) : 0;
const browsers = await Promise.all(Array.from({ length: browserCount }, () => launchBrowser('shared-ui')));
let nextBrowser = 0;
const sharedEnv = () => (browsers.length ? { ...process.env, QCHAT_TEST_BROWSER: browsers[nextBrowser++ % browsers.length].origin } : process.env);
const results = [];

// Longest first, so the slowest suites never wait behind a queue of quick ones.
const queue = [...suites].sort((a, b) => (timings[b] ?? 30) - (timings[a] ?? 30));
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const result = await run(queue.shift(), sharedEnv());
    results.push(result);
    console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.file} (${result.seconds.toFixed(1)}s)`);
  }
}));
await Promise.all(browsers.map((browser) => browser.close()));

// Anything that failed gets one clean run alone, as it had before suites shared a machine.
const firstFailures = results.filter((r) => r.code !== 0);
const failures = [];
const flaky = [];
for (const failure of firstFailures) {
  if (!retry) { failures.push(failure); continue; }
  const env = { ...process.env };
  delete env.QCHAT_TEST_BROWSER;
  const again = await run(failure.file, env);
  console.log(`${again.code === 0 ? 'PASS' : 'FAIL'} ${failure.file} (retry alone, ${again.seconds.toFixed(1)}s)`);
  if (again.code === 0) flaky.push(failure);
  else failures.push(again);
}

for (const { file, output } of failures) {
  console.log(`\n--- ${file} ---`);
  console.log(output.split('\n').filter((line) => !line.startsWith('PASS ')).slice(-40).join('\n'));
}
for (const { file, output } of flaky) {
  console.log(`\nLoad-sensitive: ${file} failed in the parallel run and passed alone:`);
  console.log(output.split('\n').filter((line) => /^FAIL |Error/.test(line)).slice(0, 5).map((line) => `  ${line.slice(0, 300)}`).join('\n'));
}

try { writeFileSync(TIMINGS, JSON.stringify({ ...timings, ...Object.fromEntries(results.map((r) => [r.file, Math.round(r.seconds * 10) / 10])) })); } catch {}
const checks = results.reduce((sum, r) => sum + r.checks, 0);
const seconds = (Date.now() - started) / 1000;
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 3).map((r) => `${r.file.replace('-test.mjs', '')} ${r.seconds.toFixed(0)}s`).join(', ');
console.log(`\n${suites.length - failures.length}/${suites.length} suites passed, ${checks} named checks, ${seconds.toFixed(1)}s with ${jobs} jobs (slowest: ${slowest})`);
process.exit(failures.length ? 1 : 0);
