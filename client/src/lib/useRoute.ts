/**
 * Where the next Generate goes, and what it would cost there — both asked of
 * the server, which knows the task table, what each resource has, and the run
 * history. Shared by the header pill, the Generate button's chooser and the
 * estimate line, so they never disagree.
 */

import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { estimate, resolveRun, useResources, type EstimateAnswer, type Resolution } from './resources';

const resolutions = new Map<string, Promise<Resolution>>();

/**
 * The resource the active workflow would run on, with the Generate button's
 * pick applied — or, with `asDefault`, what "Default" (the task's row) gives.
 */
export function useActiveRoute(asDefault = false): Resolution | null {
  const picked = useResources((s) => s.data?.choice ?? 'default');
  const choice = asDefault ? 'default' : picked;
  const version = useResources((s) => s.data);
  const active = useApp((s) => s.active);
  const [route, setRoute] = useState<Resolution | null>(null);
  useEffect(() => {
    if (!version) return;
    const task: 'video' | 'image' = active?.inspected.primaryOutputKind === 'image' ? 'image' : 'video';
    const key = `${choice}|${task}|${active?.id ?? ''}|${JSON.stringify(version.tasks)}|${version.resources.map((r) => `${r.id}${r.usable}`).join()}`;
    let p = resolutions.get(key);
    if (!p) {
      p = resolveRun({ task, override: choice === 'default' ? null : choice, workflowId: active?.id ?? '', graph: active?.api });
      resolutions.set(key, p);
      p.catch(() => resolutions.delete(key));
    }
    let alive = true;
    void p.then((r) => { if (alive) setRoute(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, [choice, version, active]);
  return route;
}

export interface ShotForEstimate { workflowId: string; seconds: number | null; scaleWithSlot: boolean }

/**
 * The estimate of a batch on one resource (or on each shot's default when
 * `resource` is 'default'). Debounced: shot lists change while markers are dragged.
 */
export function useEstimate(shots: ShotForEstimate[], resource: string): EstimateAnswer | null {
  const runsVersion = useApp((s) => s.history.length);
  const data = useResources((s) => s.data);
  const [answer, setAnswer] = useState<EstimateAnswer | null>(null);
  const key = JSON.stringify([shots, resource, runsVersion, data?.tasks, data?.resources.map((r) => r.usable)]);
  useEffect(() => {
    if (!data || shots.length === 0) { setAnswer(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      void estimate({ resource: resource === 'default' ? undefined : resource, shots: shots.map((s) => ({ ...s, resource: resource === 'default' ? undefined : resource })) })
        .then((a) => { if (alive) setAnswer(a); })
        .catch(() => { if (alive) setAnswer(null); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer;
}
