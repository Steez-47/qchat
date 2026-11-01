// Runs every offline suite: plain Node unit/bridge tests and the headless UI suites, which drive
// ui/ against the mock backend in an isolated, invisible Edge or Chromium profile.
//
//   npm test                 all offline suites
//   npm test -- collapse     only suites whose file name contains "collapse"
//
// The UI suites use Edge at its default Windows path. Elsewhere, point QCHAT_TEST_EDGE at a
// Chromium-based browser (on Linux, a wrapper that adds --no-sandbox when running as root).
//
// Not run here, because they need a debug build, a real window, the network or a signed-in
// profile: *-native-test, *-e2e, live-media-smoke, bridge-test (live ChatGPT) and tests/live/.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LIVE = new Set(['bridge-test.mjs', 'live-media-smoke.mjs']);
const filters = process.argv.slice(2);
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('-test.mjs') && !f.includes('-native-') && !LIVE.has(f))
  .filter((f) => !filters.length || filters.some((needle) => f.includes(needle)))
  .sort();

if (!suites.length) { console.error(`No suites match: ${filters.join(', ')}`); process.exit(1); }

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(dir, file)], { cwd: path.join(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => resolve({ file, code, output, seconds: (Date.now() - started) / 1000 }));
});

const failures = [];
for (const file of suites) {
  const result = await run(file);
  const ok = result.code === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${result.seconds.toFixed(1)}s)`);
  if (!ok) failures.push(result);
}

for (const { file, output } of failures) {
  console.log(`\n--- ${file} ---`);
  console.log(output.split('\n').filter((line) => !line.startsWith('PASS ')).slice(-40).join('\n'));
}
console.log(`\n${suites.length - failures.length}/${suites.length} suites passed`);
process.exit(failures.length ? 1 : 0);
