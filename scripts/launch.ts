/**
 * JustAE Flow in one go: the server, EffectCraft with its control channel, and
 * the Flow window docked beside it.
 *
 *   npm run launch                 (Windows: double-click "JustAE Flow.cmd")
 *   node scripts/launch.ts --shortcut   put a "JustAE Flow" shortcut on the desktop (Windows)
 *
 * EffectCraft opens its control channel only when it is started with
 * `--control <port>` (or EFFECTCRAFT_CONTROL_PORT), so an EffectCraft that is
 * already open without it cannot be joined: the launcher says so and leaves it
 * alone — closing it is the user's call, it may hold unsaved work.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../core/brand.ts';
import { configDir, loadSettings } from '../server/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.JUSTAE_FLOW_PORT ?? process.env.SHIFTFIELD_PORT ?? 5199);
const EC_PORT = loadSettings(root).effectcraftPort;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    const end = (ok: boolean): void => { s.destroy(); done(ok); };
    s.setTimeout(1000, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

async function waitFor(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await listening(port)) return true;
    await sleep(500);
  }
  return false;
}

function effectcraftRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      return /effectcraft\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq effectcraft.exe', '/NH'], { encoding: 'utf8' }));
    }
    execFileSync('pgrep', ['-x', 'effectcraft'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** EFFECTCRAFT_EXE, the Windows installer's folder, or `effectcraft` on the PATH. */
function effectcraftExe(): string | null {
  const candidates = [
    process.env.EFFECTCRAFT_EXE,
    process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'EffectCraft', 'effectcraft.exe') : undefined,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['effectcraft'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    return found || null;
  } catch {
    return null;
  }
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

async function main(): Promise<number> {
  if (process.argv.includes('--shortcut')) { desktopShortcut(); return 0; }

  // 1. The server.
  if (await listening(PORT)) {
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
  if (await listening(EC_PORT)) {
    console.log(`EffectCraft: connected on 127.0.0.1:${EC_PORT}`);
  } else if (effectcraftRunning()) {
    console.log(`EffectCraft is open without its control channel, so ${PRODUCT} cannot reach it.`);
    console.log(`Save your work, close EffectCraft, and run ${PRODUCT} again: it will start EffectCraft with --control ${EC_PORT}.`);
    warned = true;
  } else {
    const exe = effectcraftExe();
    if (!exe) {
      console.log(`EffectCraft not found. Install it, or set EFFECTCRAFT_EXE to effectcraft${process.platform === 'win32' ? '.exe' : ''}.`);
      warned = true;
    } else {
      spawn(exe, ['--control', String(EC_PORT)], { detached: true, stdio: 'ignore' }).unref();
      console.log(`EffectCraft: starting with --control ${EC_PORT}…`);
      if (await waitFor(EC_PORT, 90_000)) console.log(`EffectCraft: connected on 127.0.0.1:${EC_PORT}`);
      else { console.log('EffectCraft did not open its control channel in 90 s.'); warned = true; }
    }
  }

  // 3. The Flow window, docked at EffectCraft's right edge.
  const r = await fetch(`http://127.0.0.1:${PORT}/api/window/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const w = await r.json() as { how?: string; docked?: string };
  console.log(`Flow window: ${w.how ?? 'opened'}${w.docked ? ` (${w.docked === 'side' ? 'docked beside EffectCraft' : w.docked === 'over' ? 'over EffectCraft\'s right edge' : w.docked})` : ''}`);
  return warned ? 2 : 0;
}

process.exitCode = await main();
