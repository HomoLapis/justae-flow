/**
 * Copying text out of the panel.
 *
 * `navigator.clipboard.writeText` is the modern answer and it is not reliable
 * here. The panel runs in CEP — a Chromium 99 embedder — and the async
 * Clipboard API rejects whenever the embedding host does not consider the
 * document focused, which is exactly the situation when the click that asked
 * for the copy came through a CEP panel rather than a normal browser window.
 * The old call in the assistant was `void navigator.clipboard.writeText(text)`:
 * the rejection went nowhere, so a button that never copied anything also
 * never said so.
 *
 * So: try the modern API, fall back to a selection and `execCommand('copy')`,
 * which is synchronous, needs no permission, and is what the surrounding
 * runtime actually supports. And report which one worked, so the caller can
 * tell the user something true either way.
 */

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* not focused, not permitted, not implemented — the fallback handles it */
  }

  return copyViaSelection(text);
}

/**
 * The pre-Clipboard-API way, still the most dependable one inside CEP.
 *
 * The textarea has to be in the document and visible enough to be selectable —
 * `display:none` cannot hold a selection — so it is parked off-screen instead,
 * and removed in a `finally` so a throw cannot leave it behind.
 */
function copyViaSelection(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  const previous = document.activeElement as HTMLElement | null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    previous?.focus?.();
  }
}
