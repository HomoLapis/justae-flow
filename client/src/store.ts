import { create } from 'zustand';
import type { EngineState } from './api.ts';

export interface Toast { id: number; text: string; tone: 'info' | 'error' | 'ok' }

interface UiState {
  server: EngineState | null;
  serverUp: boolean;
  /** Cards selected for bulk actions, in click order. */
  selected: string[];
  /** The card open in the detail panel. */
  active: string | null;
  settingsOpen: boolean;
  wizardOpen: boolean;
  helpOpen: boolean;
  toasts: Toast[];
  setServer: (s: EngineState) => void;
  setServerUp: (ok: boolean) => void;
  select: (id: string, mode: 'only' | 'toggle' | 'range') => void;
  selectAll: () => void;
  clearSelection: () => void;
  open: (id: string | null) => void;
  set: (p: Partial<Pick<UiState, 'settingsOpen' | 'wizardOpen' | 'helpOpen'>>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  server: null,
  serverUp: false,
  selected: [],
  active: null,
  settingsOpen: false,
  wizardOpen: false,
  helpOpen: false,
  toasts: [],
  setServer: (s) => {
    const ids = new Set(s.cards.map((c) => c.id));
    const st = get();
    set({
      server: s,
      selected: st.selected.filter((id) => ids.has(id)),
      active: st.active && ids.has(st.active) ? st.active : null,
      wizardOpen: st.server === null ? !s.settings.setupDone : st.wizardOpen,
    });
  },
  setServerUp: (ok) => set({ serverUp: ok }),
  select: (id, mode) => {
    const { selected, server } = get();
    if (mode === 'only') return set({ selected: [id], active: id });
    if (mode === 'toggle') {
      return set({ selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
    }
    const order = server?.cards.map((c) => c.id) ?? [];
    const anchor = selected.at(-1) ?? id;
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    set({ selected: [...new Set([...selected, ...order.slice(a, b + 1)])] });
  },
  selectAll: () => set({ selected: get().server?.cards.filter((c) => !c.orphan).map((c) => c.id) ?? [] }),
  clearSelection: () => set({ selected: [] }),
  open: (id) => set({ active: id }),
  set: (p) => set(p),
  toast: (text, tone = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), tone === 'error' ? 7000 : 3500);
  },
}));

/** Run an API call and turn a failure into a toast instead of an unhandled rejection. */
export async function act<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (ok) useUi.getState().toast(ok, 'ok');
    return r;
  } catch (e) {
    useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error');
    return undefined;
  }
}
