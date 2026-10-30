import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
function tauri(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Always derive the native window, tray and executable icons from the source SVG.
tauri('icon', 'assets/icon.svg', '--output', 'src-tauri/icons');
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
