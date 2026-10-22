/**
 * The cost of the batch about to be queued. In Flow 2 this was shown for a
 * metered self-hosted GPU backend; none of the backends here bills per GPU
 * second through an API the panel can read, so there is nothing honest to show.
 */
export function CostEstimateLine(_props: { shots: Array<{ workflowId: string; slotSeconds: number }> }): JSX.Element | null {
  return null;
}
