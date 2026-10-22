/**
 * Thin localStorage wrapper, namespaced under `justaeflow2.*`.
 * No encryption — see Settings UI for security note.
 */

const PREFIX = 'justaeflow2.';

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded or private mode */
  }
}

export function lsDel(key: string): void {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}
