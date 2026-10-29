/**
 * Where EffectCraft is, whether it is open, and how to start it with its
 * control channel — shared by the launcher and the server.
 *
 * The Windows installer (0.18 and later) puts the app in
 * %LOCALAPPDATA%\Programs\ArtCraft\EffectCraft for one user or in
 * Program Files\ArtCraft\EffectCraft for all users, and registers it under
 * App Paths; releases before 0.18 used Program Files\EffectCraft. A portable
 * build can be anywhere: EFFECTCRAFT_EXE names it.
 *
 * EffectCraft opens the channel only when started with `--control <port>` or
 * with EFFECTCRAFT_CONTROL_PORT set (its docs/control-protocol.md). On Windows
 * the launcher sets that variable for the user once, so an EffectCraft opened
 * from the Start menu or the taskbar has the channel too.
 */

import { execFileSync, spawn, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const quiet: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };

function run(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, quiet); } catch { return null; }
}

/** The path App Paths registers for effectcraft.exe (the installer writes it in the hive of its scope). */
function appPath(hive: 'HKCU' | 'HKLM'): string | null {
  const out = run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\effectcraft.exe`, '/ve']);
  const m = out && /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out);
  const p = m?.[1].replace(/^"|"$/g, '');
  return p && existsSync(p) ? p : null;
}

/** EFFECTCRAFT_EXE, the installer's folders and registry entry, /Applications on macOS, then the PATH. */
export function effectcraftExe(): string | null {
  const named = process.env.EFFECTCRAFT_EXE;
  if (named && existsSync(named)) return named;
  const candidates: Array<string | null> = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(
      appPath('HKCU'),
      appPath('HKLM'),
      join(local, 'Programs', 'ArtCraft', 'EffectCraft', 'effectcraft.exe'),
      join(pf, 'ArtCraft', 'EffectCraft', 'effectcraft.exe'),
      join(pf86, 'ArtCraft', 'EffectCraft', 'effectcraft.exe'),
      join(pf, 'EffectCraft', 'effectcraft.exe'),
    );
  } else if (process.platform === 'darwin') {
    for (const app of ['/Applications/EffectCraft.app', join(homedir(), 'Applications', 'EffectCraft.app')]) {
      const bin = join(app, 'Contents', 'MacOS');
      if (!existsSync(bin)) continue;
      const files = readdirSync(bin).filter((f) => statSync(join(bin, f)).isFile());
      const pick = files.find((f) => f.toLowerCase() === 'effectcraft') ?? (files.length === 1 ? files[0] : null);
      if (pick) candidates.push(join(bin, pick));
    }
  } else {
    candidates.push('/usr/bin/effectcraft', '/usr/local/bin/effectcraft', join(homedir(), '.local', 'bin', 'effectcraft'));
  }
  for (const c of candidates) if (c && existsSync(c)) return c;
  const found = run(process.platform === 'win32' ? 'where' : 'which', ['effectcraft'])?.split(/\r?\n/)[0].trim();
  return found || null;
}

/** Is the desktop app a running process (with or without its channel)? */
export function effectcraftRunning(): boolean {
  if (process.platform === 'win32') return /effectcraft\.exe/i.test(run('tasklist', ['/FI', 'IMAGENAME eq effectcraft.exe', '/NH']) ?? '');
  return run('pgrep', ['-ix', 'effectcraft']) !== null;
}

export function portListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    const end = (ok: boolean): void => { s.destroy(); done(ok); };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

/** Start EffectCraft with its control channel on `port`; the path it was started from, or null when it is not found. */
export function startEffectCraft(port: number): string | null {
  const exe = effectcraftExe();
  if (!exe) return null;
  spawn(exe, ['--control', String(port)], { detached: true, stdio: 'ignore', cwd: dirname(exe) }).unref();
  return exe;
}

/** Windows: the user's EFFECTCRAFT_CONTROL_PORT, when set (read from the registry, so a stale console does not hide it). */
export function userControlPort(): string | null {
  if (process.platform !== 'win32') return null;
  const out = run('reg', ['query', 'HKCU\\Environment', '/v', 'EFFECTCRAFT_CONTROL_PORT']);
  const m = out && /REG_(?:EXPAND_)?SZ\s+(\S+)/.exec(out);
  return m ? m[1] : null;
}

/** Windows: set EFFECTCRAFT_CONTROL_PORT for the user; Explorer picks it up, so the Start menu and the taskbar start EffectCraft with it. */
export function setUserControlPort(port: number): boolean {
  return process.platform === 'win32' && run('setx', ['EFFECTCRAFT_CONTROL_PORT', String(port)]) !== null;
}

export interface HostDiagnosis {
  port: number;
  /** The channel answers on 127.0.0.1:port. */
  listening: boolean;
  /** EffectCraft is a running process. */
  running: boolean;
  /** Where it would be started from; null when it is not found. */
  exe: string | null;
  /** Windows: the user's EFFECTCRAFT_CONTROL_PORT, when set. */
  userPort: string | null;
}

/** Why the channel is down, for the launcher's messages and the Flow window's banner. */
export async function diagnoseEffectCraft(port: number): Promise<HostDiagnosis> {
  return { port, listening: await portListening(port), running: effectcraftRunning(), exe: effectcraftExe(), userPort: userControlPort() };
}
