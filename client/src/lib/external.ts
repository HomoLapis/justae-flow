/**
 * The machine around the panel: the file manager, and an image editor for a
 * reference still. In After Effects the panel opened Photoshop through CEP;
 * here nothing outside the browser is driven, except showing a folder, which
 * the JustAE Flow server does.
 */

import { serverJson } from '../bridge/server';

/** Show a file or folder in the system file manager. */
export function revealInFileManager(path: string): void {
  void serverJson('/api/fs/reveal', { path }).catch(() => undefined);
}

/** Round-trip to an external image editor: not offered here. */
export function isPhotoshopOpenSupported(): boolean {
  return false;
}

export function openInPhotoshop(_path: string): { ok: boolean; error?: string } {
  return { ok: false, error: 'Editing in an external image editor is not available here.' };
}
