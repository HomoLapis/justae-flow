/**
 * Per-user settings, kept in the user's own config folder — never in the
 * repository and never in the project. `.env` / environment variables override
 * the file, so a headless setup needs no UI at all.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { LEGACY_PRODUCT_DIR, PRODUCT } from '../core/brand.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Settings {
  comfyUrl: string;
  /** Token of an authenticating router in front of ComfyUI (a self-hosted cloud); empty for a plain ComfyUI. */
  comfyToken: string;
  /** The router's GPU key for jobs; empty = the router's default. */
  comfyGpu: string;
  host: 'effectcraft' | 'photocraft';
  effectcraftPort: number;
  photocraftPort: number;
  photocraftTokenFile: string;
  /** PhotoCraft's automation root: it may read and write only here, so the storyboard and media live here too. */
  photocraftRoot: string;
  /** PhotoCraft: workflow for a new placeholder card, and for a card made from a selection. */
  canvasPlaceholderWorkflow: string;
  selectionWorkflow: string;
  /** Workflow a new marker card starts with. */
  markerWorkflow: string;
  /** Workflow a new placeholder card starts with. */
  placeholderWorkflow: string;
  /** Default length of a placeholder, seconds. */
  placeholderSeconds: number;
  /** Seconds of host polling. */
  pollSeconds: number;
  setupDone: boolean;
}

const DEFAULTS: Settings = {
  comfyUrl: 'http://127.0.0.1:8188',
  comfyToken: '',
  comfyGpu: '',
  host: 'effectcraft',
  effectcraftPort: 9877,
  photocraftPort: 7878,
  photocraftTokenFile: '',
  photocraftRoot: '',
  canvasPlaceholderWorkflow: 'zimage-t2i',
  selectionWorkflow: 'qwen-edit',
  markerWorkflow: 'ltx25-i2v',
  placeholderWorkflow: 'ltx25-t2v',
  placeholderSeconds: 4,
  pollSeconds: 1.5,
  setupDone: false,
};

export function configDir(): string {
  const base = process.platform === 'win32'
    ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  const dir = join(base, PRODUCT);
  const legacy = join(base, LEGACY_PRODUCT_DIR);
  // Settings written under the project's former name come along once.
  if (!existsSync(dir) && existsSync(legacy)) {
    try { cpSync(legacy, dir, { recursive: true }); } catch { /* start fresh */ }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function loadSettings(repoRoot: string): Settings {
  loadDotEnv(join(repoRoot, '.env'));
  const file = join(configDir(), 'settings.json');
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>; } catch { /* first run */ }
  const s: Settings = { ...DEFAULTS, ...saved };
  if (process.env.COMFY_URL) s.comfyUrl = process.env.COMFY_URL;
  if (process.env.COMFY_TOKEN) s.comfyToken = process.env.COMFY_TOKEN;
  if (process.env.COMFY_GPU) s.comfyGpu = process.env.COMFY_GPU;
  if (process.env.EFFECTCRAFT_CONTROL_PORT) s.effectcraftPort = Number(process.env.EFFECTCRAFT_CONTROL_PORT);
  if (process.env.PHOTOCRAFT_CONTROL_PORT) s.photocraftPort = Number(process.env.PHOTOCRAFT_CONTROL_PORT);
  if (process.env.PHOTOCRAFT_CONTROL_TOKEN_FILE) s.photocraftTokenFile = process.env.PHOTOCRAFT_CONTROL_TOKEN_FILE;
  if (process.env.PHOTOCRAFT_AUTOMATION_ROOT) s.photocraftRoot = process.env.PHOTOCRAFT_AUTOMATION_ROOT;
  const host = process.env.JUSTAE_FLOW_HOST ?? process.env.SHIFTFIELD_HOST;
  if (host === 'effectcraft' || host === 'photocraft') s.host = host;
  if (!s.photocraftTokenFile) s.photocraftTokenFile = join(configDir(), 'photocraft.token');
  if (!s.photocraftRoot) s.photocraftRoot = join(homedir(), 'Documents', PRODUCT, 'PhotoCraft');
  return s;
}

export function saveSettings(s: Settings): void {
  const file = join(configDir(), 'settings.json');
  writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
  renameSync(file + '.tmp', file);
}
