/**
 * Keeping the workflow library in step with the world.
 *
 * Three things change under us and all three have to be noticed without the
 * user pressing anything: the provider they picked, the workflows sitting on
 * that server, and the workflow they selected. This hook owns that loop —
 * list, read, convert, and hand the panel a ready record.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../state/store';
import { buildProvider, providerConfig } from '../providers/registry';
import type { ObjectInfo, VideoProvider } from '../providers/types';
import { HttpError } from '../providers/ComfyHttpProvider';
import {
  listProjectWorkflows, listServerWorkflows, materialize, initialValues,
  type WorkflowRecord, type WorkflowSummary,
} from './library';
import { watchWorkflowFolder } from './watch';
import { resolveFlowRoot } from '../lib/assets';
import { nodeAvailable } from '../lib/fs';

export interface LibraryApi {
  provider: VideoProvider | null;
  providerError: string | null;
  refresh: () => Promise<void>;
  /** Make a workflow the default for new shots. */
  select: (id: string) => Promise<void>;
  /** Read a workflow into the session cache without changing the default. */
  ensureRecord: (id: string) => Promise<void>;
  /** The node catalogue of the active provider, once fetched. */
  objectInfo: ObjectInfo | null;
}

/**
 * Requests already in flight, shared by every instance of the hook.
 *
 * A shot list mounts one row per shot and each row asks for its workflow at
 * the same instant. Without this, ten shots on the same workflow meant ten
 * identical reads and ten downloads of the node catalogue — several megabytes
 * each — all at once, which looks exactly like a server that has stopped
 * answering. Module scope rather than a ref because the Workflow tab and the
 * shot tabs are separate instances asking for the same things.
 */
const inFlightRecords = new Map<string, Promise<WorkflowRecord>>();
let inFlightObjectInfo: { key: string; promise: Promise<ObjectInfo | null> } | null = null;
/**
 * A listing already running. Belt and braces alongside the content-compare in
 * the store: whatever asks for a refresh — a mount, a tab switch, a failed
 * read, the folder watcher — at most one is ever in flight, so no combination
 * of them can turn into a storm of requests.
 */
let inFlightRefresh: Promise<void> | null = null;

/**
 * The node catalogue, cached for the whole session rather than per hook
 * instance.
 *
 * The Workflow tab and the shot tabs mount and unmount as the user switches
 * between them, and each mount used to start from nothing — re-downloading
 * several megabytes through a CPU Builder that may be cold. That is what left
 * a shot row sitting on "Reading the workflow…" for minutes at a time.
 */
const objectInfoCache = new Map<string, ObjectInfo>();

export function useLibrary(): LibraryApi {
  const settings = useApp((s) => s.settings);
  const activeId = useApp((s) => s.activeId);
  const setLibrary = useApp((s) => s.setLibrary);
  const setLibraryError = useApp((s) => s.setLibraryError);
  const setLibraryLoading = useApp((s) => s.setLibraryLoading);
  const setActive = useApp((s) => s.setActive);
  const setActiveId = useApp((s) => s.setActiveId);
  const setValues = useApp((s) => s.setValues);
  const setRecord = useApp((s) => s.setRecord);
  const setRecordError = useApp((s) => s.setRecordError);
  const resetFieldLocks = useApp((s) => s.resetFieldLocks);

  const providerKey = [
    settings.provider, settings.localComfyUrl, settings.comfyCloudApiKey,
    settings.comfyV2Target, settings.comfyV2Url, settings.comfyV2Token, settings.comfyV2ProxyToken,
  ].join('|');

  const { provider, providerError } = useMemo(() => {
    try {
      return {
        provider: buildProvider(settings.provider, providerConfig(settings)),
        providerError: null as string | null,
      };
    } catch (e) {
      return { provider: null, providerError: e instanceof Error ? e.message : String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey]);

  /**
   * The node catalogue. Needed for every editor-format workflow, so it's
   * fetched once per provider and reused — it's several megabytes.
   */
  const getObjectInfo = useCallback(async (): Promise<ObjectInfo | null> => {
    if (!provider?.objectInfo) return null;
    const cached = objectInfoCache.get(providerKey);
    if (cached) return cached;
    if (inFlightObjectInfo?.key === providerKey) return inFlightObjectInfo.promise;

    const promise = provider.objectInfo()
      .then((info) => {
        objectInfoCache.set(providerKey, info);
        return info;
      })
      .finally(() => {
        if (inFlightObjectInfo?.key === providerKey) inFlightObjectInfo = null;
      });
    inFlightObjectInfo = { key: providerKey, promise };
    return promise;
  }, [provider, providerKey]);

  const listAll = useCallback(async (): Promise<void> => {
    setLibraryLoading(true);
    setLibraryError(null);
    const found: WorkflowSummary[] = [];
    let problem: string | null = null;

    if (provider) {
      try {
        found.push(...(await listServerWorkflows(provider)));
      } catch (e) {
        problem = `Could not read the workflows on ${provider.label}: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else if (providerError) {
      problem = providerError;
    }

    if (nodeAvailable()) {
      try {
        const root = await resolveFlowRoot(useApp.getState().settings);
        found.push(...listProjectWorkflows(root.dir));
      } catch {
        // No saved project yet — the project folder simply has nothing to offer.
      }
    }

    setLibrary(dedupe(found));
    setLibraryError(problem);
    setLibraryLoading(false);
  }, [provider, providerError, setLibrary, setLibraryError, setLibraryLoading]);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlightRefresh) return inFlightRefresh;
    const run = listAll().finally(() => { inFlightRefresh = null; });
    inFlightRefresh = run;
    return run;
  }, [listAll]);

  /** The actual read. Wrapped by ensureRecordInner, which handles sharing. */
  const readRecord = useCallback(async (id: string, force: boolean): Promise<WorkflowRecord> => {
    const summary = useApp.getState().library.find((w) => w.id === id);
    if (!summary) throw new Error('That workflow is no longer in the library — refresh the list.');
    const info = await getObjectInfo();

    let record;
    try {
      record = await materialize(summary, provider, info);
    } catch (e) {
      // Gone from the server since we listed it — renamed or deleted in the
      // editor. Drop it from the picker instead of leaving a dead entry that
      // 404s every time it's chosen.
      if (e instanceof HttpError && e.status === 404) {
        setLibrary(useApp.getState().library.filter((w) => w.id !== id));
        void refresh();   // pull the current names, so the picker is right again
        throw new Error(
          `"${summary.name}" is no longer on the server — it was renamed or deleted. `
          + 'The list has been refreshed.',
        );
      }
      throw e;
    }
    setRecord(record);
    useApp.getState().setRecordError(id, null);
    // Seed values only when there are none: re-reading a workflow the user has
    // been tuning must not throw their numbers away.
    if (!useApp.getState().values[record.id] || force) {
      setValues(record.id, initialValues(record, useApp.getState().presets[record.id]));
    }
    return record;
  }, [getObjectInfo, provider, refresh, setLibrary, setRecord, setValues]);

  /**
   * Read a workflow and cache it, seeding its field values from the saved
   * preset. Callers can be many and simultaneous — one shot row per shot, all
   * asking on mount — so identical requests share a single read.
   */
  const ensureRecordInner = useCallback(async (id: string, force = false): Promise<WorkflowRecord> => {
    const cached = useApp.getState().records[id];
    if (cached && !force) return cached;
    const pending = inFlightRecords.get(id);
    if (pending && !force) return pending;

    const promise = readRecord(id, force).finally(() => {
      if (inFlightRecords.get(id) === promise) inFlightRecords.delete(id);
    });
    inFlightRecords.set(id, promise);
    return promise;
  }, [readRecord]);

  const ensureRecord = useCallback(async (id: string): Promise<void> => {
    setLibraryLoading(true);
    setRecordError(id, null);
    try {
      await ensureRecordInner(id);
    } catch (e) {
      // Reported against the workflow, not globally: the row that asked is the
      // one that needs to say something, and a row stuck on "Reading…" with the
      // reason hidden in a banner elsewhere is worse than no message at all.
      setRecordError(id, e instanceof Error ? e.message : String(e));
    } finally {
      setLibraryLoading(false);
    }
  }, [ensureRecordInner, setLibraryLoading, setRecordError]);

  /** Read a workflow and make it the default for new shots. */
  const select = useCallback(async (id: string): Promise<void> => {
    setActiveId(id);
    if (!id) { setActive(null); return; }

    setLibraryLoading(true);
    try {
      const record = await ensureRecordInner(id, true);
      setActive(record);
      resetFieldLocks();
      setLibraryError(record.problems.length > 0 ? record.problems.join('\n') : null);
    } catch (e) {
      setActive(null);
      setLibraryError(e instanceof Error ? e.message : String(e));
    } finally {
      setLibraryLoading(false);
    }
  }, [ensureRecordInner, resetFieldLocks, setActive, setActiveId, setLibraryError, setLibraryLoading]);

  // Re-list whenever the provider changes.
  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * Re-open the workflow that was selected last session, once the list is in.
   *
   * Tried exactly once per id. Retrying was the other half of the loop: when
   * the stored workflow can't be read, `select` reports the failure and
   * refreshes the list, the refresh changes what this effect watches, and it
   * tries again — forever, several requests per turn. One attempt, then the
   * error stands until the user picks something.
   */
  const library = useApp((s) => s.library);
  const active = useApp((s) => s.active);
  const reopened = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (active || !activeId || reopened.current.has(activeId)) return;
    if (!library.some((w) => w.id === activeId)) return;
    reopened.current.add(activeId);
    void select(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, activeId, active]);

  /**
   * Notice workflows saved from the editor. This is what makes the "edit it in
   * ComfyUI, hit save, use it here" loop work without a button: /userdata has
   * no change feed, so we poll it.
   */
  const editorOpen = useApp((s) => s.editorOpened);
  useEffect(() => {
    const store = provider?.workflows?.();
    // Nothing can change the folder behind our back until the user has opened
    // the editor, so don't poll the server before that.
    if (!store || !editorOpen) return;
    return watchWorkflowFolder(
      () => store.list(),
      () => {
        void (async (): Promise<void> => {
          // Await the re-list before deciding what to re-read. Firing both at
          // once raced: `select` looked the workflow up in the OLD list, found
          // an entry for a file that had just been renamed away, and asked the
          // server for a path that no longer existed — a bare HTTP 404 in the
          // panel for something the user had legitimately just done.
          await refresh();
          const current = useApp.getState().active;
          if (current?.origin !== 'server') return;
          if (!useApp.getState().library.some((w) => w.id === current.id)) {
            // The open workflow is the one that went away. Say so rather than
            // leave a form bound to a file that isn't there.
            useApp.getState().setActive(null);
            useApp.getState().setActiveId('');
            setLibraryError(`"${current.name}" is no longer on the server — it was renamed or deleted.`);
            return;
          }
          await select(current.id);
        })();
      },
    );
  }, [provider, editorOpen, refresh, select, setLibraryError]);

  return {
    provider, providerError, refresh, select, ensureRecord,
    objectInfo: objectInfoCache.get(providerKey) ?? null,
  };
}

function dedupe(list: WorkflowSummary[]): WorkflowSummary[] {
  const seen = new Set<string>();
  const out: WorkflowSummary[] = [];
  for (const w of list) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
