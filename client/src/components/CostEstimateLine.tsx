/**
 * What the batch about to be queued will take, said with its basis — under
 * the Generate button.
 *
 *   ≈ 36–52 cr (~$0.20) · ~2:56–4:14 min on Comfy Cloud · based on 3 runs on RTX PRO 6000
 *   Comfy Cloud · first run: 12.3 cr/min on RTX PRO 6000 · no run of this workflow here yet
 *   Local ComfyUI · no credits · ~32 s (based on 2 runs)
 *   8 shots · ≈ 310 cr (~$1.47) · ~24 min on Comfy Cloud · based on …
 *
 * The numbers are the server's (POST /api/estimate): earlier runs of the same
 * workflow on the same resource and GPU, scaled by the slot for video, times
 * the GPU's rate. No endpoint states a job's price in advance, so "≈" is never
 * dropped. When the balance is under twice the high end, a yellow line offers
 * to switch to Local.
 */

import { formatCredits, useResources } from '../lib/resources';
import { useEstimate, type ShotForEstimate } from '../lib/useRoute';

export function CostEstimateLine({ shots }: { shots: ShotForEstimate[] }): JSX.Element | null {
  const choice = useResources((s) => s.data?.choice ?? 'default');
  const credits = useResources((s) => s.credits);
  const choose = useResources((s) => s.choose);
  const answer = useEstimate(shots, choice);
  if (!answer || !answer.total.text) return null;
  const t = answer.total;
  const metered = t.creditsPerMinute !== null || t.creditsHigh !== null;
  const low = metered && t.creditsHigh !== null && credits?.ok && credits.credits !== null && credits.credits < 2 * t.creditsHigh;

  return (
    <div className="space-y-1.5" data-testid="estimate-line">
      <p className="text-[10px] leading-snug text-ink-mute" title="Derived from earlier runs of this workflow on this resource (execution time × the GPU's rate). No endpoint states a job's price in advance.">
        <span className={metered ? 'text-ink-dim' : undefined}>{t.text}</span>
        {answer.shots.length > 1 && t.resources.length > 1 && (
          <span> · {answer.shots.map((s) => s.label).filter((x, i, a) => a.indexOf(x) === i).join(' + ')}</span>
        )}
      </p>
      {low && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-snug text-ink">
          <span className="text-warn">●</span>
          <span className="min-w-0 flex-1">
            Credit nearly used up: {formatCredits(credits!.credits!)} cr left, this batch ≈ up to {formatCredits(t.creditsHigh!)} cr.
          </span>
          <button className="chip h-6 px-2 py-0 text-[11px]" onClick={() => void choose('local')}>Switch to Local</button>
        </div>
      )}
    </div>
  );
}
