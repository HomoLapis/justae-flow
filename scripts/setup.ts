/**
 * The last step of `npm run setup`, after `npm install` and the build: the
 * git hooks (in a clone; a ZIP download has no .git and is fine without
 * them), then a look at what the launcher will need, so a missing piece is
 * named here rather than at the first run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../core/brand.ts';
import { effectcraftExe } from '../hosts/effectcraft/locate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (existsSync(join(root, '.git'))) {
  try { execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' }); } catch { /* no git on the PATH: the hooks are for contributors */ }
}

function onPath(cmd: string): boolean {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

const [major, minor] = process.versions.node.split('.').map(Number);
const lines: string[] = [];
lines.push(major > 22 || (major === 22 && minor >= 18) ? `  ✔ Node.js ${process.versions.node}` : `  ✖ Node.js ${process.versions.node}: ${PRODUCT} needs 22.18 or newer (https://nodejs.org)`);
lines.push(onPath('ffmpeg') ? '  ✔ ffmpeg on the PATH' : '  ✖ ffmpeg is not on the PATH: install it (https://ffmpeg.org/download.html), frames and renders need it');
const exe = effectcraftExe();
lines.push(exe ? `  ✔ EffectCraft: ${exe}` : `  ✖ EffectCraft not found: install it from https://github.com/storytold/effectcraft/releases, or set EFFECTCRAFT_EXE to its effectcraft${process.platform === 'win32' ? '.exe' : ''}`);
console.log(`\n${PRODUCT} is built.\n${lines.join('\n')}\n\nNext: npm run launch${process.platform === 'win32' ? ' (or double-click "JustAE Flow.cmd")' : ''}.`);
