import { useEffect, useState } from 'react';
import { useAssist, type AssistProvider } from '../lib/assist';
import { KeyField, UrlField } from './ResourcesSettings';

const PROVIDERS: Array<{ id: AssistProvider; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'lmstudio', label: 'LM Studio (local)' },
  { id: 'claude', label: 'Claude (API key)' },
];

/** Settings ▸ Prompt assistant: where ✦ Improve sends a prompt, and with which model. */
export function AssistSettings(): JSX.Element {
  const view = useAssist((s) => s.view);
  const load = useAssist((s) => s.load);
  const save = useAssist((s) => s.save);
  const listModels = useAssist((s) => s.models);
  const [models, setModels] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { if (!view) void load(); }, [view, load]);

  const provider = view?.provider ?? 'off';
  const url = view?.url ?? '';
  const refresh = async (): Promise<void> => {
    setNote('Reading the model list…');
    const r = await listModels();
    setModels(r.models);
    setNote(r.ok ? (r.models.length ? null : 'No models there yet.') : r.error ?? 'Could not read the models.');
  };
  useEffect(() => {
    setModels(null);
    setNote(null);
    if (view && provider !== 'off') void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, url]);

  if (!view) return <section className="space-y-2"><h3 className="section-label">Prompt assistant</h3></section>;

  const choices = models ?? (provider === 'claude' ? view.claudeModels : []);
  return (
    <section className="space-y-2" data-testid="assist-settings">
      <h3 className="section-label">Prompt assistant</h3>
      <p className="text-[10px] leading-snug text-ink-mute">
        ✦ Improve, under a prompt, has a language model rewrite it for the shot: a local one through Ollama or LM
        Studio, or Claude with your API key. Nothing is sent until you press it.
      </p>
      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-dim">Where</span>
        <select className="input text-xs" value={provider} onChange={(e) => void save({ provider: e.target.value as AssistProvider })} data-testid="assist-provider">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {(provider === 'ollama' || provider === 'lmstudio') && (
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-dim">Address</span>
          <UrlField value={view.url} placeholder={view.urls[provider]} onSave={(u) => save({ url: u })} />
        </label>
      )}
      {provider === 'claude' && (
        <KeyField set={view.key.set} tail={view.key.tail} file={view.key.file} label="Anthropic API key"
          placeholder="sk-ant-… from console.anthropic.com" onSave={(k) => save({ apiKey: k })} />
      )}
      {provider !== 'off' && (
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-dim">Model</span>
          <div className="flex items-center gap-1.5">
            <ModelField value={view.model} choices={choices} placeholder={provider === 'claude' ? view.claudeModels[0] : choices[0] ?? 'the model\'s name'} onSave={(m) => save({ model: m })} />
            <button className="btn-quiet h-8 px-2 text-[11px]" onClick={() => void refresh()}>Refresh</button>
          </div>
          {note && <p className="mt-1 text-[10px] text-ink-mute">{note}</p>}
        </label>
      )}
      {provider === 'ollama' && (
        <p className="text-[10px] leading-snug text-ink-mute">
          Ollama lists the models it has pulled (<span className="font-mono text-ink-dim">ollama pull qwen3:8b</span>, for one); the first answer loads the model, later ones are quick.
        </p>
      )}
      {provider === 'lmstudio' && (
        <p className="text-[10px] leading-snug text-ink-mute">
          In LM Studio, load a model and start the local server (Developer tab); it is listed here.
        </p>
      )}
      {provider === 'claude' && (
        <p className="text-[10px] leading-snug text-ink-mute">
          The key is kept by the JustAE Flow server in your user folder and sent to api.anthropic.com only. It comes from
          console.anthropic.com and is billed per use; a Claude.ai subscription does not include it.
        </p>
      )}
    </section>
  );
}

function ModelField({ value, choices, placeholder, onSave }: { value: string; choices: string[]; placeholder: string; onSave: (v: string) => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <input
        className="input h-8 min-h-0 flex-1 py-1 font-mono text-[11px]"
        list="assist-models"
        value={draft ?? value}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null && draft.trim() !== value) void onSave(draft.trim()); setDraft(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        data-testid="assist-model"
      />
      <datalist id="assist-models">{choices.map((m) => <option key={m} value={m} />)}</datalist>
    </>
  );
}
