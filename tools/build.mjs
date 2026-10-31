import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const installer = process.argv.includes('--installer');
function tauri(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Always derive the native window, tray and executable icons from the source SVG.
tauri('icon', 'assets/icon.svg', '--output', 'src-tauri/icons');
if (installer) {
  const notices = spawnSync(process.execPath, [path.join(root, 'tools/third-party-notices.mjs')], { cwd: root, stdio: 'inherit' });
  if (notices.error) throw notices.error;
  if (notices.status !== 0) process.exit(notices.status ?? 1);
  tauri('build', '--bundles', 'nsis');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = path.join(root, 'dist', `v${version}`);
  mkdirSync(release, { recursive: true });
  const setup = `QChat_${version}_x64-setup.exe`;
  for (const [source, name] of [
    [`src-tauri/target/release/bundle/nsis/${setup}`, setup],
    ['src-tauri/target/release/qchat.exe', 'QChat.exe'],
    ['packaging/INSTALL.txt', 'INSTALL.txt'],
    ['src-tauri/resources/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt']
  ]) copyFileSync(path.join(root, source), path.join(release, name));
  const names = [setup, 'QChat.exe', 'INSTALL.txt', 'THIRD-PARTY-NOTICES.txt'];
  writeFileSync(path.join(release, 'SHA256SUMS.txt'), names.map(name => `${createHash('sha256').update(readFileSync(path.join(release, name))).digest('hex')}  ${name}`).join('\n') + '\n');
  console.log(`Installer release ready: ${release}`);
  process.exit(0);
}
tauri('build', '--no-bundle');
const destination = path.join(root, 'dist', 'QChat.exe');
const staged = `${destination}.tmp`;
mkdirSync(path.dirname(destination), { recursive: true });
try {
  copyFileSync(path.join(root, 'src-tauri', 'target', 'release', 'qchat.exe'), staged);
  renameSync(staged, destination);
} catch (error) {
  rmSync(staged, { force: true });
  throw new Error('Could not replace dist/QChat.exe. Quit QChat and run the build again.', { cause: error });
}
console.log(`Build ready: ${destination}`);
