/**
 * Noticing that the workflow folder changed.
 *
 * The editor is a browser window now, not something the panel can talk to, so
 * this is the whole of the round trip: the user saves in ComfyUI, the file
 * lands in the server's workflow folder, and the panel sees it appear. Polling,
 * not a socket, because `/userdata` has no change feed.
 *
 * Every tick costs a round trip AND, on a cloud server, a volume reload, so the
 * cadence is deliberately lazy — it exists to catch a save made by a human in
 * another window, not to follow a stream of events.
 */

export function watchWorkflowFolder(
  list: () => Promise<Array<{ path: string; modified?: number }>>,
  onChange: (files: Array<{ path: string; modified?: number }>) => void,
  intervalMs = 15_000,
): () => void {
  let stopped = false;
  let fingerprint = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const files = await list();
      const next = files
        .map((f) => `${f.path}@${f.modified ?? 0}`)
        .sort()
        .join('|');
      if (next !== fingerprint) {
        const first = fingerprint === '';
        fingerprint = next;
        if (!first) onChange(files);
      }
    } catch {
      /* server asleep or redeploying — try again next tick */
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();

  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
