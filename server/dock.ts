/**
 * The Flow window, opened as if it were a panel docked in EffectCraft.
 *
 * EffectCraft docks only ScriptUI panels — it has no web panels like After
 * Effects' CEP — so Flow 2's interface runs in an app window of Edge or Chrome,
 * with a profile of its own so it keeps the page's settings. On Windows
 * `dock.ps1` puts it at EffectCraft's right edge, full height, and keeps it there
 * while EffectCraft moves; elsewhere the window just opens.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../core/brand.ts';
import { BROWSERS } from './bridge.ts';

/** Width of the Flow window in CSS pixels: Flow 2's panel width in After Effects. */
const WIDTH = 560;

let follower: ChildProcess | null = null;

export interface OpenResult { ok: boolean; how: string; docked?: string }

function spawnWindow(exe: string, url: string, profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', `--window-size=${WIDTH},980`], { detached: true, stdio: 'ignore' }).unref();
}

export async function openFlowWindow(url: string, profileDir: string): Promise<OpenResult> {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
      : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
    spawn(opener[0], [...opener[1]], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, how: 'default browser' };
  }
  if (process.platform !== 'win32') {
    spawnWindow(exe, url, profileDir);
    return { ok: true, how: 'app window' };
  }

  // One helper at a time: a new open takes over from the one following now.
  follower?.kill();
  const script = join(dirname(fileURLToPath(import.meta.url)), 'dock.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Width', String(WIDTH), '-WaitMs', '20000', '-Title', PRODUCT], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  follower = child;

  return await new Promise<OpenResult>((done) => {
    let buf = '';
    let opened = false;
    let settled = false;
    const open = (): void => { if (!opened) { opened = true; spawnWindow(exe, url, profileDir); } };
    const finish = (docked: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok: true, how: 'app window', docked });
    };
    // Docking is a nicety: whatever happens to the helper, the window opens.
    const timer = setTimeout(() => { open(); finish('no answer from the dock helper'); }, 30_000);
    child.on('error', () => { open(); finish('dock helper could not start'); });
    child.on('close', () => {
      if (follower === child) follower = null;
      open();
      finish('dock helper stopped');
    });
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: { stage?: string; mode?: string };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        if (m.stage === 'found') opened = true;
        else if (m.stage === 'missing') open();
        else if (m.stage === 'docked') finish(m.mode ?? 'side');
        else if (m.stage === 'alone' || m.stage === 'timeout') finish('EffectCraft window not found');
      }
    });
  });
}

/** Stop following EffectCraft (server shutdown). */
export function stopDock(): void {
  follower?.kill();
  follower = null;
}
