import type { OutputFile } from './types.ts';

export type HistoryOutputs = Record<string, Record<string, unknown>> | undefined;

interface FileItem { filename: string; subfolder?: string; type?: string }

function isFileItem(v: unknown): v is FileItem {
  return !!v && typeof v === 'object' && typeof (v as FileItem).filename === 'string';
}

/** Every file a finished job wrote, from the `outputs` of its /history entry. */
export function extractOutputs(outputs: HistoryOutputs): OutputFile[] {
  const out: OutputFile[] = [];
  for (const [nodeId, byKind] of Object.entries(outputs ?? {})) {
    if (!byKind || typeof byKind !== 'object') continue;
    for (const [bucket, items] of Object.entries(byKind)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isFileItem(item)) continue;
        out.push({
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: (item.type as OutputFile['type']) ?? 'output',
          bucket,
          nodeId,
        });
      }
    }
  }
  return out;
}
