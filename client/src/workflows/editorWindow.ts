/**
 * The ComfyUI editor in a real window the panel can still drive.
 *
 * Ported from JustPhotoshop, where every line below was paid for with a
 * measurement. Flow 2 needs it for the half of the round trip it was missing:
 * "Open in browser" could open the editor, but not the workflow the user had
 * just selected — and telling someone to go and find it themselves in a list of
 * four hundred is not a round trip.
 *
 * Why not `window.open`
 * ---------------------
 * CEF inside an Adobe host blocks every form of it — with dimensions, without,
 * named, `_blank`. Verified against a live panel through the debug port, with
 * `--disable-popup-blocking` already in the manifest and the host restarted:
 * four attempts out of four returned `null`. That flag governs Chrome's popup
 * blocker, which is not what decides here.
 *
 * What works instead
 * ------------------
 * The panel has Node (`--enable-nodejs`), so it can launch a real browser in
 * app mode — a clean window, no address bar, movable to another screen. Started
 * with `--remote-debugging-port`, that window can also be TALKED to over the
 * DevTools protocol, which is how the panel loads the selected workflow into it.
 * No `window.open`, nothing blocked.
 *
 * `cep.util.openURLInDefaultBrowser` remains the fallback (see
 * `bridge/csInterface.ts`): it always opens the editor, it just cannot put a
 * particular workflow on the canvas.
 */

import { serverJson } from '../bridge/server';
import { nodeRequest } from '../lib/httpNode';

/**
 * 9334, not 9333: JustPhotoshop's editor window owns that one, and two panels
 * sharing a debug port means whichever browser started first answers for both.
 */
export const DEBUG_PORT = 9334;

/**
 * `fetch` with a deadline, WITHOUT `AbortSignal.timeout`.
 *
 * The panel runs in CEF, which in CEP 12 is Chrome 99 (read live off its user
 * agent). `AbortSignal.timeout` arrives in Chrome 103: there it does not return
 * undefined, it THROWS. In JustPhotoshop all three calls to the debug port used
 * it, and all three sat inside a `try/catch` that turns any stumble into "the
 * window isn't there" — so the panel declared the editor window permanently
 * closed, waited sixteen seconds, and fell back to the in-panel editor, which
 * with a modern ComfyUI does not work at all. The whole separate-window branch
 * was dead and invisible, because the tests ran in Node, where the method
 * exists.
 *
 * `AbortController` does exist in Chrome 99 (verified) and does the same job.
 */
async function shortFetch(url: string, ms: number): Promise<Response> {
  // The debug port answers no CORS: the JustAE Flow server asks for us.
  const r = await nodeRequest(url, { timeoutMs: ms });
  return new Response(new Uint8Array(r.bytes), { status: r.status, headers: r.headers });
}

export interface WindowResult {
  ok: boolean;
  /** Why it could not be done, when ok is false. */
  reason?: string;
  /**
   * We started it just now, rather than finding it already open.
   *
   * It matters to whoever loads a workflow into it: only a freshly started
   * window has a session restore on the way that can overwrite them.
   */
  started?: boolean;
}

/** Is the browser already open on our port? */
export async function windowAlive(port = DEBUG_PORT): Promise<boolean> {
  try {
    const r = await shortFetch(`http://127.0.0.1:${port}/json/version`, 700);
    return r.ok;
  } catch { return false; }
}

/**
 * Bring the editor window forward — it is another application.
 *
 * A button that says "bring to front" and brings nothing to the front is worse
 * than no button. The window is a separate process and the panel cannot touch
 * it; the debug port can, and it is the same road we use to load the workflow.
 */
export async function bringToFront(port = DEBUG_PORT): Promise<boolean> {
  let pages: Array<{ type: string; webSocketDebuggerUrl?: string }>;
  try {
    pages = await (await shortFetch(`http://127.0.0.1:${port}/json`, 1500)).json();
  } catch { return false; }
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return false;
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(page.webSocketDebuggerUrl!);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* nothing */ } resolve(false); }, 3000);
      const done = (v: boolean): void => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* nothing */ }
        resolve(v);
      };
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }));
      ws.onmessage = (ev) => {
        try { done(!JSON.parse(String(ev.data)).error); } catch { done(false); }
      };
      ws.onerror = () => done(false);
    } catch { resolve(false); }
  });
}

/**
 * Open the editor in a browser window, unless it is already open.
 *
 * `profileDir` is a working directory of its own: without one the browser
 * reuses the user's session and ignores the debug port.
 */
export async function openEditorWindow(
  url: string,
  profileDir: string,
  port = DEBUG_PORT,
): Promise<WindowResult> {
  if (await windowAlive(port)) { await bringToFront(port); return { ok: true, started: false }; }
  /*
   * The server starts Edge or Chrome as an app window on the debug port, with
   * --remote-allow-origins set to this page's origin only: from Chrome 111
   * DevTools refuses a WebSocket that carries an Origin it was not told about,
   * and opening it to anyone would hand any local page the controls.
   */
  try {
    const r = await serverJson<{ ok: boolean; reason?: string }>('/api/fs/launch-editor', { url, profileDir, port, origin: window.location.origin });
    if (!r.ok) return { ok: false, reason: r.reason ?? 'The editor window could not be started.' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // The browser takes a moment to open the port.
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 400));
    if (await windowAlive(port)) return { ok: true, started: true };
  }
  return { ok: false, reason: 'The window started but is not answering on the debug port.' };
}

/** How well the load went. `identity` is the one that makes Ctrl+S overwrite. */
export type LoadOutcome = 'identity' | 'graph-only' | 'no';

/**
 * How long to keep trying before giving up on a load.
 *
 * Generous on purpose, and the reason is measured: on this machine ComfyUI's
 * frontend hands out `app.loadGraphData` after 2.0 s and its workflow list
 * after 2.3 s, but does not finish REGISTERING its node types until 24.9 s —
 * `/object_info` is several megabytes and 6794 classes. A cold server, or one
 * busy rendering, takes longer still. The old ceiling of ~45 s was close enough
 * to that to be a coin toss.
 */
const LOAD_DEADLINE_MS = 180_000;

/**
 * Which load is the current one.
 *
 * A load can spend up to forty-five seconds retrying while ComfyUI starts up.
 * If the user picks a different workflow in the meantime, the old attempt must
 * stop rather than land on the canvas after the new one — so each load takes a
 * ticket and a stale one gives up.
 *
 * This does NOT govern the session-restore guard further down; that one is
 * re-aimed rather than cancelled, for reasons written where it lives.
 */
let loadGeneration = 0;

/**
 * Load the named workflow into the window, BY PATH.
 *
 * The expression runs inside the ComfyUI page: it fetches the file from the
 * server itself, so there is no JSON to ship across, and it tries the same two
 * roads the old iframe bridge did — first the one that gives the graph its
 * identity (so Ctrl+S overwrites the file), then the plain load.
 */
export async function loadIntoWindow(
  path: string,
  port = DEBUG_PORT,
  justStarted = false,
  onProgress?: (message: string) => void,
): Promise<LoadOutcome> {
  /*
   * ComfyUI takes several seconds to come up: the page answers immediately but
   * `app` appears much later. Giving up on the first try found a live page and
   * no app, and the window opened empty.
   */
  const generation = ++loadGeneration;

  /*
   * Point the running guard at the new choice BEFORE loading, not after.
   *
   * It used to be re-aimed only once the load had succeeded, and in between the
   * two were pulling in opposite directions: the guard still holding the
   * previous workflow noticed "not ours", put its own graph back mid-flight,
   * and the window came to rest with the new workflow's NAME over the old
   * workflow's NODES — the very state all of this exists to prevent. Seen live
   * while testing the repair path.
   */
  if (guardRunning) guardTarget = path;

  let outcome: Attempt = 'wait';
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  /** When an attempt first got past the node-registration gate. */
  let pastGateAt: number | null = null;
  let saidWaitingForApp = false;
  let saidWaitingForNodes = false;

  while (Date.now() < deadline) {
    // A newer load has taken over: stop competing with it.
    if (generation !== loadGeneration) return 'no';
    /*
     * FALL BACK ONLY AFTER GIVING THE WORKFLOW LIST TIME TO ARRIVE.
     *
     * `loadGraphData` is not an equal second choice: it puts the nodes on the
     * canvas with no name, and Ctrl+S then asks where to save them. On a cold
     * start `app` exists straight away while the workflow list arrives later,
     * so falling back on the first try produced the WORST result every single
     * time — measured: 'graph-only' on every open from a closed window.
     *
     * The clock for it now starts at the node-registration gate rather than at
     * the first attempt. Counting attempts from the start put the fallback at
     * roughly eighteen seconds — BEFORE the moment ComfyUI becomes able to
     * build its nodes at all — so the second choice was taken while the first
     * one was still unavailable, and taken in the very state that produces a
     * canvas full of placeholders.
     */
    const allowFallback = pastGateAt !== null && Date.now() - pastGateAt > 10_000;
    outcome = await oneAttempt(path, port, allowFallback);
    if (outcome === 'not-listed' && pastGateAt === null) pastGateAt = Date.now();
    if (outcome === 'identity' || outcome === 'graph-only') break;

    if (outcome === 'nodes-pending' && !saidWaitingForNodes) {
      saidWaitingForNodes = true;
      onProgress?.('ComfyUI is still registering its node types — loading the workflow before that '
        + 'finishes is what turns every node red. Waiting (about 25 s from a cold window).');
    } else if (outcome === 'wait' && !saidWaitingForApp && !saidWaitingForNodes) {
      saidWaitingForApp = true;
      onProgress?.('Waiting for the ComfyUI page to come up…');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  /*
   * The guard runs BEHIND, for EVERY successful load.
   *
   * It used to run only for a window the panel had just started, on the
   * reasoning that an already-open window had done its restoring long ago.
   * That reasoning is wrong, and `pnpm verify:editor` caught it against a live
   * ComfyUI: open workflow A, then B a moment later, and twenty-five seconds
   * after that the canvas says "Unsaved Workflow". The restore is driven by the
   * SERVER's record of what was open, not by the browser profile — a fresh
   * profile does not avoid it — and it lands long after both loads, on whatever
   * is on screen by then.
   *
   * Waiting for it here would freeze the panel for half a minute, so it stays
   * in the background; the outcome the user sees is reported immediately.
   */
  if (outcome === 'identity' || outcome === 'graph-only') defend(path, port);
  void justStarted;
  // Everything else — still waiting when the deadline ran out, or an outright
  // failure — is one thing to the caller: the workflow is not on that canvas.
  return outcome === 'identity' || outcome === 'graph-only' ? outcome : 'no';
}

/**
 * The workflow the guard is currently defending, and whether one is running.
 *
 * One guard, re-aimed — not one per load. Cancelling the old guard when a new
 * load arrives was the first attempt and it made things worse: it left the gap
 * between the second load and the restore completely undefended. What the user
 * wants held is simply their latest choice.
 */
let guardTarget: string | null = null;
let guardRunning = false;

function defend(path: string, port: number): void {
  guardTarget = path;
  if (guardRunning) return;
  guardRunning = true;
  void holdOurGround(port).finally(() => { guardRunning = false; });
}

/**
 * Everything but 'identity', 'graph-only' and 'no' means "not yet, try again",
 * and they are told apart only so the panel can say WHAT it is waiting for and
 * so the nameless fallback starts its clock at the right moment.
 *
 *   wait           the page is up but `app` is not there yet
 *   nodes-pending  `app` is there and its node types are not registered yet
 *   not-listed     nodes are ready; the workflow is not in the store's list yet
 */
type Attempt = 'identity' | 'graph-only' | 'wait' | 'nodes-pending' | 'not-listed' | 'no';

/**
 * Hold the canvas until session restore has finished having its say.
 *
 * RESTORE ARRIVES LATER, AND IT WINS.
 *
 * Measured on a window started with a real profile: `window.app` is there at
 * zero seconds, so the load succeeds and reports 'identity' — and then ComfyUI
 * finishes restoring the previous session and puts the old workflow back. The
 * panel had already declared victory and stopped looking: from outside it
 * looked as though it always opened the same file, whatever the dropdown said.
 *
 * Two things make the defect slippery. With a FRESH profile it does not happen
 * at all — there is no session to restore — which is how it got through the
 * first time. And the moment is not fixed: measured at six seconds in one run,
 * fifteen and eighteen in others. So waiting "a bit" is not enough, and neither
 * is seeing our graph sit still for a few rounds: you have to watch the restore
 * ARRIVE, put ours back, and only then stop.
 *
 * (The clean route, `?workflow=` in the URL, was tried too: this frontend
 * version ignores it.)
 */
async function holdOurGround(port: number): Promise<boolean> {
  const norm = (v: string | null | undefined): string =>
    String(v ?? '').replace(/\\/g, '/').replace(/^workflows\//, '');

  let watching = '';
  let overridden = false;
  let steady = 0;

  // ~45 s: the measured ceiling for restore, with margin. The clock restarts
  // whenever the target changes, because a new choice deserves the full window.
  for (let round = 0; round < 64; round++) {
    await new Promise((r) => setTimeout(r, 700));

    const wanted = guardTarget;
    if (!wanted) return false;
    const target = norm(wanted);
    if (target !== watching) {
      // Re-aimed at the user's newer choice: start counting again.
      watching = target;
      overridden = false;
      steady = 0;
      round = 0;
    }

    const state = await currentState(port);
    const now = norm(state?.path);
    /*
     * Ours means THREE things: the right name on the tab, the right graph under
     * it, and that graph made of real nodes. Checking only the name is what let
     * the window sit there renamed and unchanged while this loop reported
     * everything as fine; ignoring the placeholders let it sit there with the
     * right workflow drawn entirely in red.
     */
    const isOurs = (now === target || (target !== '' && now.endsWith(`/${target}`)))
      && state?.matches !== false
      && (state?.stale ?? 0) === 0;
    if (isOurs) {
      // Stopping here before having seen the restore would leave the field to
      // whoever comes afterwards — which is exactly how it slipped through.
      if (overridden && ++steady >= 3) return true;
    } else if (now !== '') {
      overridden = true;
      steady = 0;
      // No fallback: if we are here something overrode us, and putting an
      // unnamed graph back would hide it happening again. By now the workflow
      // list has had time to arrive, so this second go succeeds where the
      // first one fell back.
      await oneAttempt(wanted, port, false);
    }
  }
  return false;
}

/**
 * Two helpers, injected into the page by everything below.
 *
 * `registeredTypes` — how many node classes ComfyUI has built. THIS IS THE GATE
 * the whole red-nodes defect turned on. Litegraph's `configure` calls
 * `LiteGraph.createNode(type)` for every node in the file and, when that
 * returns nothing, quietly substitutes a bare `LGraphNode` carrying the
 * original json in `last_serialization` and `has_errors = true` — the red
 * outline. Nothing ever revisits that decision, so a graph loaded one second
 * too early stays a canvas of red placeholders even though the nodes were
 * installed all along. Measured on this machine: `app.loadGraphData` and the
 * workflow list are both ready at ~2.3 s and the registry is still EMPTY until
 * 24.9 s, when all 6794 classes appear at once. The panel was loading at 2.3 s.
 *
 * `stalePlaceholders` — placeholders whose type IS registered now, which is the
 * signature of exactly that mistake and of nothing else. A genuinely missing
 * custom node is a placeholder for a type that is NOT in the registry and must
 * be left alone; a healthy node has no `last_serialization` at all (the
 * frontend sets that field on the placeholder path only — three places in the
 * bundle, all of them "type not found"). So this counts repairs that are owed,
 * never work that is in progress.
 */
const PAGE_HELPERS = `
  const __LG = window.LiteGraph ?? window.comfyAPI?.litegraph?.LiteGraph ?? null;
  const __registry = () => (__LG && __LG.registered_node_types) || null;
  const __registeredTypes = () => { const r = __registry(); return r ? Object.keys(r).length : -1; };
  const __stalePlaceholders = (graph) => {
    const reg = __registry();
    if (!reg) return 0;
    let n = 0;
    for (const node of (graph && graph._nodes) || []) {
      if (!node || !node.last_serialization) continue;
      const t = node.last_serialization.type ?? node.type;
      if (t && reg[t]) n++;
    }
    return n;
  };
`;

/** What the window is showing: the name on the tab, and the graph under it. */
export interface EditorState {
  /** The file the active tab is bound to — what Ctrl+S would write to. */
  path: string | null;
  /**
   * Whether the canvas actually holds that workflow's graph.
   *
   * THE NAME IS NOT ENOUGH, and believing it was is what let the defect below
   * live for a whole round. `activeWorkflow` and the canvas are two different
   * things in this frontend and can be made to disagree; when they do, the tab
   * says one workflow and the nodes on screen are another's.
   */
  matches: boolean;
  /**
   * Nodes sitting on the canvas as red placeholders for types that ARE
   * installed. Anything above zero is a graph that was loaded too early and is
   * owed a reload — see PAGE_HELPERS.
   */
  stale: number;
}

/**
 * Which workflow the window has open — and whether the canvas agrees.
 *
 * The agreement is decided on the GRAPH ID, and getting that wrong the first
 * time nearly did real damage. Comparing node counts looked equivalent and is
 * not: ComfyUI's change tracker checkpoints `activeState` on its own schedule,
 * so a node the user has just added leaves the canvas at 25 and the state at 24
 * indefinitely — measured, still 25 vs 24 four seconds later. A guard reading
 * that as "someone swapped the graph" reloads the file and the user's addition
 * is gone. The id is carried by the graph itself, survives every edit, and
 * differs exactly when two different workflows are involved:
 *
 *   after a real load     graph 33e7a6d5 · state 33e7a6d5     agree
 *   after adding a node   graph 33e7a6d5 · state 33e7a6d5     still agree
 *   in the broken state   graph 33e7a6d5 · state 0112e9af     caught
 *
 * When either id is missing (a workflow file old enough not to carry one) the
 * answer is "can't tell", and can't-tell must read as fine: acting on it would
 * mean reloading over somebody's work on a hunch.
 */
async function currentState(port: number): Promise<EditorState | null> {
  const v = await evaluateInPage<string>(`(() => {
    ${PAGE_HELPERS}
    const app = window.app ?? window.comfyAPI?.app?.app;
    const s = app?.extensionManager?.workflow;
    if (!s) return null;
    const graphId = (app.rootGraph ?? app.graph)?.id ?? null;
    const stateId = s.activeWorkflow?.activeState?.id ?? null;
    return JSON.stringify({
      path: s.activeWorkflow?.path ?? null,
      matches: !graphId || !stateId ? true : graphId === stateId,
      stale: __stalePlaceholders(app.rootGraph ?? app.graph),
    });
  })()`, port, 4000);
  if (!v) return null;
  try { return JSON.parse(v) as EditorState; } catch { return null; }
}

async function oneAttempt(path: string, port: number, allowFallback: boolean): Promise<Attempt> {
  /*
   * The FILE is opened, through the frontend's own workflow list.
   *
   * `app.workflowManager` no longer exists in this version (probed live); in
   * its place is `app.extensionManager.workflow`, a store with
   * `loadWorkflows()`, `workflows` and `openWorkflow(w)`.
   *
   * THAT STORE METHOD DOES NOT PUT THE GRAPH ON THE CANVAS, and calling it was
   * the whole defect. Read off the shipped bundle (frontend 1.49.6, the build
   * this panel talks to), `useWorkflowStore().openWorkflow` is four lines: push
   * the path into the open tabs, `await workflow.load()`, set `activeWorkflow`,
   * tint the canvas background. It never touches litegraph. So the tab was
   * renamed to the chosen workflow while the nodes on screen stayed whatever
   * they were — "it always opens the same workflow, only the name changes".
   *
   * Worse than cosmetic, and measured on two throwaway files: in that state a
   * Ctrl+S in the editor writes THE GRAPH ON SCREEN into the file whose name is
   * on the tab. A 7-node workflow came back with the other one's 24 nodes.
   *
   * What ComfyUI itself does when you click a workflow in its sidebar is
   * `useWorkflowService().openWorkflow`, which is not reachable from outside
   * the bundle (it is not on `window.comfyAPI` — checked, 36 namespaces, no
   * workflowService). Its body, however, is public API from here:
   *
   *     if (!workflow.isLoaded) await workflow.load()
   *     await app.loadGraphData(toRaw(workflow.activeState), true, true, workflow, …)
   *
   * The fourth argument is the identity: `loadGraphData` hands it to
   * `afterLoadNewGraph`, which calls the same `store.openWorkflow` — so the
   * tab, the change tracker and the canvas all end up on the same file, and
   * Ctrl+S overwrites it rather than asking for a name. `toRaw` has no
   * equivalent out here; a JSON round trip of a file that was JSON a moment ago
   * loses nothing and hands litegraph a plain object rather than a Vue proxy.
   *
   * `loadGraphData` with no workflow stays as the fallback: nodes on the canvas
   * with no name, which is what used to produce "unsaved workflow".
   */
  const expression = `(async () => {
    ${PAGE_HELPERS}
    const app = window.app ?? window.comfyAPI?.app?.app;
    if (!app) return 'wait';
    /*
     * THE GATE. Nothing below may run while the node registry is empty: see
     * PAGE_HELPERS for what loading early actually does to the canvas. When
     * LiteGraph cannot be reached at all the count is -1 — unknown, and unknown
     * must not block, because a frontend that moved the object somewhere else
     * would otherwise make the Edit button stop working entirely. The
     * after-the-fact check at the bottom still catches that case.
     */
    if (__registeredTypes() === 0) return 'nodes-pending';
    const wanted = ${JSON.stringify(path)};
    const allowFallback = ${allowFallback ? 'true' : 'false'};
    try {
      const s = app.extensionManager?.workflow;
      if (s && app.loadGraphData) {
        await s.loadWorkflows?.();
        /*
         * THE COMPARISON IS EXACT.
         *
         * This was \`.includes(wanted)\`, and with nearly four hundred
         * workflows in the list (measured: 397) it only takes one name being
         * the tail of another for \`find\` to return the first of the two —
         * that is, to open a different file from the one chosen, silently. The
         * panel's path and the store's differ only by the "workflows/" prefix;
         * strip that and compare in full.
         */
        const norm = (v) => String(v ?? '').replace(/\\\\/g, '/').replace(/^workflows\\//, '');
        const target = norm(wanted);
        const list = s.workflows ?? [];
        const w = list.find((x) => norm(x.path) === target || norm(x.key) === target)
          // Fallback for when the panel knows only the file name: the leading
          // slash stops "Foo.json" latching onto "MyFoo.json".
          ?? list.find((x) => norm(x.path).endsWith('/' + target) || norm(x.key).endsWith('/' + target));
        if (w) {
          /*
           * Already there AND on screen: leave it alone, exactly as ComfyUI's
           * own service does. Reloading would throw away edits the user has
           * made in the editor and not yet saved. The graph-id check is the
           * other half of it — if the tab is ours but the graph under it is
           * not, this is the broken state and it has to be repaired, not left.
           * (Ids, not node counts: see currentState below for why.)
           */
          const graphId = (app.rootGraph ?? app.graph)?.id ?? null;
          const stateId = s.activeWorkflow?.activeState?.id ?? null;
          const settled = norm(s.activeWorkflow?.path) === norm(w.path)
            && (!graphId || !stateId || graphId === stateId)
            // A canvas of red placeholders for installed nodes is not "already
            // there": it is the state this reload exists to repair. Without
            // this clause pressing Edit again on the same workflow — the first
            // thing anyone tries — did nothing at all.
            && __stalePlaceholders(app.rootGraph ?? app.graph) === 0;
          if (settled) return 'identity';

          if (!w.isLoaded) await w.load();
          /*
           * Which copy of the workflow to put on the canvas.
           *
           * Normally the one ComfyUI is holding: \`activeState\` carries edits
           * made in the editor and not yet saved, and dropping those every time
           * the panel opens a workflow would be its own kind of data loss.
           *
           * But that copy can itself be wrong, and in the field it IS wrong
           * right now: every window the previous version of this panel drove is
           * carrying workflows whose in-memory state was overwritten with
           * another graph's nodes — reproduced here, workflow B's \`activeState\`
           * holding A's twenty-four. Loading that faithfully would be the same
           * damage with better manners.
           *
           * The two are told apart by the graph id, which an edit does not
           * change: if the working copy's id is no longer the id of the file it
           * came from, that copy is not this workflow's and the file wins.
           */
          const live = w.activeState;
          const fromFile = w.initialState;
          let data = live;
          if (live && fromFile && live.id && fromFile.id && live.id !== fromFile.id) {
            const r = await fetch('/api/userdata/' + encodeURIComponent(w.path));
            if (r.ok) data = await r.json();
          }
          await app.loadGraphData(
            JSON.parse(JSON.stringify(data)), true, true, w,
            { checkForRerouteMigration: false, deferWarnings: true },
          );
          /*
           * Say what came out, not what was intended.
           *
           * The gate above is the fix; this is the proof that it held. If the
           * canvas still carries placeholders for installed types, the registry
           * was not where we looked for it and the load happened too early
           * anyway — reporting 'nodes-pending' sends the caller round again
           * instead of declaring a red canvas a success.
           */
          return __stalePlaceholders(app.rootGraph ?? app.graph) > 0 ? 'nodes-pending' : 'identity';
        }
        // Nodes are ready, the workflow is simply not in the list yet.
        return allowFallback ? await fallback() : 'not-listed';
      }
    } catch (e) { /* try the fallback */ }
    // The list may not have arrived yet: the caller decides whether to wait for
    // it or settle for a graph with no name.
    if (!allowFallback) return 'not-listed';
    return await fallback();

    async function fallback() {
      if (!app.loadGraphData) return 'no';
      const r = await fetch('/api/userdata/' + encodeURIComponent('workflows/' + wanted));
      if (!r.ok) return 'no';
      await app.loadGraphData(await r.json());
      return __stalePlaceholders(app.rootGraph ?? app.graph) > 0 ? 'nodes-pending' : 'graph-only';
    }
  })()`;

  const v = await evaluateInPage<string>(expression, port);
  return v === 'identity' || v === 'graph-only' || v === 'wait'
    || v === 'nodes-pending' || v === 'not-listed'
    ? v
    : 'no';
}

/**
 * Run an expression inside the editor page, over the debug port.
 *
 * `undefined` when it could not be done: no window, page not ready, timed out.
 * The caller decides what to make of that — no distinction is drawn here,
 * because for the panel they are all the same case: try again.
 */
async function evaluateInPage<T>(expression: string, port: number, waitMs = 20000): Promise<T | undefined> {
  let pages: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
  try {
    pages = await (await shortFetch(`http://127.0.0.1:${port}/json`, 1500)).json();
  } catch { return undefined; }
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return undefined;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v?: T): void => { if (!done) { done = true; resolve(v); } };
    try {
      const ws = new WebSocket(page.webSocketDebuggerUrl!);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* nothing */ } finish(undefined); }, waitMs);
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.id !== 1) return;
          clearTimeout(timer);
          try { ws.close(); } catch { /* nothing */ }
          finish(m.result?.result?.value as T);
        } catch { /* not our message */ }
      };
      ws.onerror = () => { clearTimeout(timer); finish(undefined); };
    } catch { finish(undefined); }
  });
}
