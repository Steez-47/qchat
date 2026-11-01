// Stamp only a disposable build checkout; main keeps its normal release version.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function stampNightly(root, number) {
  if (!/^[1-9]\d*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) throw new Error('Invalid nightly build number');
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable source version');
  const version = `${pkg.version}-nightly.${number}`;
  const changes = new Map();
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const json = JSON.parse(read(file));
    json.version = version;
    if (file === 'package-lock.json') json.packages[''].version = version;
    changes.set(file, JSON.stringify(json, null, 2) + '\n');
  }
  for (const [file, pattern] of [
    ['src-tauri/Cargo.toml', /^(version = ")[^"]+("\r?$)/m],
    ['src-tauri/Cargo.lock', /(name = "qchat"\r?\nversion = ")[^"]+(")/]
  ]) {
    const text = read(file);
    if (!pattern.test(text)) throw new Error(`Missing package version in ${file}`);
    changes.set(file, text.replace(pattern, (_, before, after) => before + version + after));
  }
  for (const [file, text] of changes) writeFileSync(path.join(root, file), text);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(stampNightly(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2]));
}
