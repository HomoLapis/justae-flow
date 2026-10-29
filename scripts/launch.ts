/**
 * JustAE Flow in one go: the server, EffectCraft with its control channel, and
 * the Flow window docked beside it.
 *
 *   npm run launch                 (Windows: double-click "JustAE Flow.cmd")
 *   npm run launch -- --no-env     do not set EFFECTCRAFT_CONTROL_PORT for the Windows user
 *   node scripts/launch.ts --shortcut   put a "JustAE Flow" shortcut on the desktop (Windows)
 *
 * EffectCraft opens its control channel only when it is started with
 * `--control <port>` or with EFFECTCRAFT_CONTROL_PORT set, so an EffectCraft
 * already open without it cannot be joined: the launcher says so and leaves it
 * alone — closing it is the user's call, it may hold unsaved work. On Windows
 * the launcher sets that variable for the user once, so from then on the Start
 * menu and the taskbar open EffectCraft with the channel as well.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../core/brand.ts';
import { effectcraftRunning, portListening, setUserControlPort, startEffectCraft, userControlPort } from '../hosts/effectcraft/locate.ts';
import { configDir, loadSettings } from '../server/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.JUSTAE_FLOW_PORT ?? process.env.SHIFTFIELD_PORT ?? 5199);
const EC_PORT = loadSettings(root).effectcraftPort;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portListening(port)) return true;
    await sleep(500);
  }
  return false;
}

function desktopShortcut(): void {
  if (process.platform !== 'win32') {
    console.log('A desktop shortcut is made on Windows only; elsewhere run `npm run launch`.');
    return;
  }
  const target = join(root, `${PRODUCT}.cmd`);
  const ps = [
    "$d = [Environment]::GetFolderPath('Desktop')",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d '${PRODUCT}.lnk'))`,
    `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${root.replace(/'/g, "''")}'`,
    '$s.WindowStyle = 1',
    `$s.Description = 'The JustAE Flow server, EffectCraft and the Flow window'`,
    '$s.Save()',
    "Join-Path $d '" + PRODUCT + ".lnk'",
  ].join('; ');
  const where = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  console.log(`Shortcut: ${where}`);
}

/** Windows: EffectCraft started from the Start menu or the taskbar has no channel unless the user variable asks for one. */
function userVariable(): void {
  if (process.platform !== 'win32' || process.argv.includes('--no-env')) return;
  const have = userControlPort();
  if (have === null) {
    if (setUserControlPort(EC_PORT)) {
      console.log(`EffectCraft: EFFECTCRAFT_CONTROL_PORT=${EC_PORT} is now set for your Windows user, so EffectCraft opens its control`);
      console.log('  channel (127.0.0.1 only) however you start it. "npm run launch -- --no-env" skips this; docs/SETUP.md says how to remove it.');
    }
  } else if (have !== String(EC_PORT)) {
    console.log(`Note: your Windows user has EFFECTCRAFT_CONTROL_PORT=${have} while this launcher uses ${EC_PORT}; open a new terminal so they agree.`);
  }
}

async function main(): Promise<number> {
  if (process.argv.includes('--shortcut')) { desktopShortcut(); return 0; }

  // 1. The server.
  if (await portListening(PORT)) {
    console.log(`${PRODUCT} server: already running on 127.0.0.1:${PORT}`);
  } else {
    mkdirSync(configDir(), { recursive: true });
    const log = join(configDir(), 'server.log');
    const out = openSync(log, 'a');
    spawn(process.execPath, [join(root, 'server', 'index.ts')], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    if (!(await waitFor(PORT, 20_000))) {
      console.error(`${PRODUCT} server did not start — see ${log}`);
      return 1;
    }
    console.log(`${PRODUCT} server: started on 127.0.0.1:${PORT} (log: ${log})`);
  }

  // 2. EffectCraft, with its control channel. A warning makes the exit code 2, so JustAE Flow.cmd stays open to be read.
  let warned = false;
  userVariable();
  if (await portListening(EC_PORT)) {
    console.log(`EffectCraft: connected on 127.0.0.1:${EC_PORT}`);
  } else if (effectcraftRunning()) {
    console.log(`EffectCraft is open without its control channel, so ${PRODUCT} cannot reach it.`);
    console.log(`Save your work, close EffectCraft and start it again${process.platform === 'win32' ? ' (this launcher, or the Start menu now that the variable is set)' : ` with this launcher (effectcraft --control ${EC_PORT})`}.`);
    warned = true;
  } else {
    const exe = startEffectCraft(EC_PORT);
    if (!exe) {
      console.log(`EffectCraft not found. Install it from https://github.com/storytold/effectcraft/releases, or set EFFECTCRAFT_EXE to its effectcraft${process.platform === 'win32' ? '.exe' : ''}.`);
      warned = true;
    } else {
      console.log(`EffectCraft: starting ${exe} with --control ${EC_PORT}…`);
      if (await waitFor(EC_PORT, 90_000)) console.log(`EffectCraft: connected on 127.0.0.1:${EC_PORT}`);
      else { console.log('EffectCraft did not open its control channel in 90 s.'); warned = true; }
    }
  }

  // 3. The Flow window, docked at EffectCraft's right edge. Opened even after a warning: its banner says what is missing.
  const r = await fetch(`http://127.0.0.1:${PORT}/api/window/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const w = await r.json() as { how?: string; docked?: string };
  console.log(`Flow window: ${w.how ?? 'opened'}${w.docked ? ` (${w.docked === 'side' ? 'docked beside EffectCraft' : w.docked === 'over' ? 'over EffectCraft\'s right edge' : w.docked})` : ''}`);
  return warned ? 2 : 0;
}

process.exitCode = await main();
