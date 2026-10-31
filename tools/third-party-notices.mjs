import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'cargo metadata failed');
const metadata = JSON.parse(result.stdout);
const overrides = path.join(root, 'packaging/licenses');
const overrideFiles = readdirSync(overrides);
const sections = ['QChat third-party notices\n\nNative dependency license texts and source references follow.\nSource archives are available at https://crates.io/api/v1/crates/NAME/VERSION/download.\nMPL-2.0 components are unmodified; their source is available at the linked crate pages.\nMicrosoft Edge WebView2 is distributed under Microsoft terms, independently of these open-source components.'];
for (const pkg of metadata.packages.filter(p => p.name !== 'qchat').sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const directory = path.dirname(pkg.manifest_path);
  let files = readdirSync(directory, { withFileTypes: true }).filter(f => f.isFile() && /^(licen[cs]e|copying|notice|unlicense)/i.test(f.name)).map(f => path.join(directory, f.name));
  if (pkg.license_file) files.push(path.resolve(directory, pkg.license_file));
  if (!files.length) {
    const prefix = pkg.name.startsWith('webview2-com') ? 'webview2-com' : pkg.name;
    files = overrideFiles.filter(f => f.startsWith(`${prefix}-`) && !f.endsWith('-SOURCE.txt')).map(f => path.join(overrides, f));
  }
  if (!files.length) throw new Error(`Missing license text: ${pkg.name} ${pkg.version}`);
  const texts = [...new Set(files)].map(file => `${path.basename(file)}\n${readFileSync(file, 'utf8')}`).join('\n\n');
  sections.push(`${pkg.name} ${pkg.version}\nLicense: ${pkg.license || 'See license text'}\nSource: https://crates.io/crates/${pkg.name}/${pkg.version}\n${pkg.repository || ''}\n\n${texts}`);
}
for (const [name, file] of [['Marked 12.0.2', 'packaging/licenses/marked-LICENSE.md'], ['KaTeX and bundled fonts', 'ui/vendor/katex/LICENSE'], ['Acorn', 'ui/vendor/acorn.LICENSE']]) {
  sections.push(`${name}\n\n${readFileSync(path.join(root, file), 'utf8')}`);
}
const destination = path.join(root, 'src-tauri/resources/THIRD-PARTY-NOTICES.txt');
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, sections.join('\n\n' + '='.repeat(72) + '\n\n'), 'utf8');
console.log(`Dependency notices ready: ${metadata.packages.length - 1} native packages plus UI libraries`);
