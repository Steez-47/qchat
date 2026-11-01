import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stampNightly } from '../tools/nightly-version.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'qchat-nightly-'));
try {
  mkdirSync(path.join(dir, 'src-tauri'));
  const files = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  for (const file of files) writeFileSync(path.join(dir, file), readFileSync(new URL(`../${file}`, import.meta.url)));
  const base = JSON.parse(readFileSync(path.join(dir, 'package.json'))).version;
  for (const bad of ['', '-1', '0', '1.2', '1\n2', '9007199254740992']) assert.throws(() => stampNightly(dir, bad));
  assert.equal(stampNightly(dir, 42), `${base}-nightly.42`);
  for (const file of files) assert.ok(readFileSync(path.join(dir, file), 'utf8').includes(`${base}-nightly.42`), file);
  const lock = JSON.parse(readFileSync(path.join(dir, 'package-lock.json')));
  assert.equal(lock.packages[''].version, `${base}-nightly.42`);
  assert.throws(() => stampNightly(dir, 43), /stable source version/);
  console.log('PASS Nightly versions agree across all build manifests; invalid and repeated stamps are refused');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
