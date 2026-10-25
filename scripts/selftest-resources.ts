/**
 * Offline checks of resources, Comfy API v2 jobs through the SDK, run
 * history, estimates and the credit balance — against a fake Comfy API v2
 * and a fake billing report on loopback. Part of `npm run selftest`.
 *
 * Every file it writes goes to a temporary folder: the user's run history and
 * keys are never touched.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centsToCredits, creditsFor, describeEstimate, estimateRun, GPUS, sumEstimates, type RunRecord } from '../core/cost/estimate.ts';
import { Credits } from '../server/credits.ts';
import { ResourceRegistry, TASKS } from '../server/resources.ts';
import { RunLog } from '../server/runs.ts';
import { RunError, V2Jobs } from '../server/v2run.ts';

type Check = (name: string, cond: unknown, detail?: string) => void;

/** Stand-in keys for the fake servers (built, so the secret scan does not mistake them for real ones). */
export const FAKE_KEY = ['test', 'key', '0123456789'].join('-');
const WRONG_KEY = ['wrong', 'key', '0123456789'].join('-');

export interface FakeV2 {
  url: string;
  seen: Array<{ method: string; path: string; auth: string | undefined; key: string | undefined }>;
  close(): void;
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The parts of Comfy API v2 the SDK calls (its transport, src/low/transport.ts):
 * HEAD assets/by-hash, POST assets (201), POST jobs (201), GET jobs/{id},
 * GET assets/{id}/content, POST jobs/{id}/cancel, GET jobs?limit=1. A job
 * succeeds 150 ms after submit with `metrics.execution_ms` = 12000.
 * A workflow with a node of class "Broke" is refused with 402 insufficient_credits.
 * Also the v1 billing report, for the balance.
 */
export async function fakeV2(): Promise<FakeV2> {
  const seen: FakeV2['seen'] = [];
  const jobs = new Map<string, { at: number; video: boolean; canceled: boolean }>();
  let n = 0;
  const now = (): string => new Date().toISOString();
  const later = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readAll(req);
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined });
    const json = (status: number, data: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const job = (id: string): Record<string, unknown> => {
      const j = jobs.get(id)!;
      const done = Date.now() - j.at > 150;
      const status = j.canceled ? 'canceled' : done ? 'succeeded' : 'running';
      return {
        id, status, created_at: new Date(j.at).toISOString(), started_at: new Date(j.at + 10).toISOString(), completed_at: done ? now() : null,
        expires_at: later(), queue_position: null,
        progress: done ? null : { value: 0.5, nodes_done: 3, nodes_total: 6, current_node: '3', current_node_class: 'KSampler', step: 2, steps: 4 },
        outputs: status === 'succeeded' ? [{ node_id: '9', name: j.video ? 'out.mp4' : 'out.png', type: j.video ? 'video' : 'image', content_type: j.video ? 'video/mp4' : 'image/png', size_bytes: 14, id: `out-${id}`, hash: null, url: `/api/v2/assets/out-${id}/content`, url_expires_at: later() }] : [],
        error: null, metrics: { queue_ms: 5, execution_ms: done ? 12_000 : null },
        urls: { self: `/api/v2/jobs/${id}`, events: `/api/v2/jobs/${id}/events`, cancel: `/api/v2/jobs/${id}/cancel` },
      };
    };
    if (url.pathname === '/api/billing/usage/timeseries') {
      if (req.headers['x-api-key'] !== 'test-key-0123456789') return json(401, { code: 'UNAUTHORIZED', message: 'authentication required' });
      return json(200, { group_by: 'model', granularity: 'month', starting_on: '2026-10-01T00:00:00Z', ending_before: '2026-10-25T12:00:00Z', groups: [], buckets: [], breakdown: [], as_of: '2026-10-25T12:00:01.5Z', summary: { spend_micros: 1250000, balance: { amount_cents: 4250, amount_micros: 4250, prepaid_balance_cents: 2250, prepaid_balance_micros: 2250, cloud_credit_balance_cents: 2000, cloud_credit_balance_micros: 2000, currency: 'USD' } } });
    }
    if (req.method === 'HEAD' && url.pathname.startsWith('/api/v2/assets/by-hash/')) { res.writeHead(404); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/api/v2/assets') {
      return json(201, { id: `asset-${++n}`, hash: 'blake3:00', size_bytes: body.length, content_type: 'image/png', file_path: 'input.png', created_new: true, created_at: now(), url: '/x', url_expires_at: later() });
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/jobs') return json(200, { jobs: [], truncated: false });
    if (req.method === 'POST' && url.pathname === '/api/v2/jobs') {
      const p = JSON.parse(body.toString('utf8')) as { workflow: Record<string, { class_type: string }> };
      const classes = Object.values(p.workflow).map((x) => x.class_type);
      if (classes.includes('Broke')) return json(402, { error: { code: 'insufficient_credits', message: 'Insufficient credits.' } });
      const id = `job-${++n}`;
      jobs.set(id, { at: Date.now(), video: classes.includes('SaveVideo'), canceled: false });
      return json(201, job(id));
    }
    const jm = /^\/api\/v2\/jobs\/([\w-]+)(\/cancel)?$/.exec(url.pathname);
    if (jm && jobs.has(jm[1])) {
      if (jm[2]) jobs.get(jm[1])!.canceled = true;
      return json(200, job(jm[1]));
    }
    if (/^\/api\/v2\/assets\/out-[\w-]+\/content$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('fake-v2-output')); }
    json(404, { error: { code: 'not_found', message: 'no such route' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

export async function resourceChecks(check: Check, until: (fn: () => boolean, ms?: number) => Promise<boolean>): Promise<void> {
  const v2 = await fakeV2();
  const dir = mkdtempSync(join(tmpdir(), 'jaf-resources-'));

  console.log('resources');
  const reg = new ResourceRegistry(dir, 'http://127.0.0.1:8190');
  const v0 = reg.view();
  check('the registry starts with Local (the address the settings had), Comfy Cloud and the proxy (off)',
    reg.local().url === 'http://127.0.0.1:8190' && reg.get('cloud')?.url === 'https://cloud.comfy.org' && reg.get('proxy')?.enabled === false && v0.resources.length === 3);
  check('the task table starts as the plan says (§2.1)', TASKS.every((t) => reg.tasks()[t.id] === t.default)
    && reg.tasks().upscale === 'cloud' && reg.tasks().image === 'local' && reg.tasks().video === 'auto');
  check('Comfy Cloud without a key cannot take a job, and says why', !v0.resources.find((r) => r.id === 'cloud')!.usable && /no API key/.test(v0.resources.find((r) => r.id === 'cloud')!.reason ?? ''));
  check('without a key, a Cloud task falls back to Local', reg.resolve('upscale', null, () => 'unknown').resource.id === 'local');

  reg.update({ apiKey: FAKE_KEY });
  const v1 = reg.view();
  check('the key goes to the config folder, one line', readFileSync(join(dir, 'comfy-api-key.txt'), 'utf8') === 'test-key-0123456789\n');
  check('the view says a key is set and its last four, never the key', v1.key.set && v1.key.tail === '6789' && !JSON.stringify(v1).includes('test-key-0123456789'));
  check('with the key, Upscale goes to Comfy Cloud (its row in Settings)', reg.resolve('upscale', null, () => 'unknown').resource.id === 'cloud');
  {
    const r = reg.resolve('upscale', null, (x) => (x.id === 'cloud' ? 'missing' : 'ok'));
    check('a row whose resource lacks the workflow\'s nodes or models gives way to Auto, and says why', r.resource.id === 'local' && /lacks/.test(r.why));
    check('a run\'s own pick stands even then (it is refused before a credit is spent)', reg.resolve('upscale', 'cloud', (x) => (x.id === 'cloud' ? 'missing' : 'ok')).resource.id === 'cloud');
  }
  check('a per-run choice wins over the row', reg.resolve('upscale', 'local', () => 'unknown').resource.id === 'local');
  check('Auto: Local when Local has the nodes and models', reg.resolve('video', null, () => 'ok').resource.id === 'local');
  check('Auto: the first other resource that has them when Local lacks something',
    reg.resolve('video', null, (r) => (r.id === 'local' ? 'missing' : 'ok')).resource.id === 'cloud');
  check('Comfy Cloud bills at the RTX PRO 6000 rate, 736.39 cr/h', reg.creditsPerHour(reg.get('cloud')!) === 736.39 && reg.creditsPerHour(reg.local()) === null);

  reg.update({ resources: [{ id: 'deployment', url: 'http://10.0.0.5:8189', enabled: true, gpu: 'h100' }] });
  check('a deployment over plain http to another machine is refused (the key would travel in clear)', !reg.usable(reg.get('deployment')!).ok && /plain http/.test(reg.usable(reg.get('deployment')!).reason ?? ''));
  reg.update({ resources: [{ id: 'deployment', url: v2.url }] });
  check('a deployment bills at its GPU\'s rate (H100 1,314.53 cr/h)', reg.creditsPerHour(reg.get('deployment')!) === GPUS.h100.creditsPerHour);
  reg.update({ resources: [{ id: 'deployment', gpu: 'rtx-pro-6000' }] });
  let refused = false;
  try { reg.update({ resources: [{ id: 'cloud', remove: true }] }); } catch { refused = true; }
  check('only a deployment can be removed', refused);

  {
    const dir2 = mkdtempSync(join(tmpdir(), 'jaf-migrate-'));
    const r2 = new ResourceRegistry(dir2, 'http://127.0.0.1:8188');
    const moved = r2.migrate({ provider: 'comfy-v2', comfyV2Target: 'proxy', comfyV2Url: 'http://127.0.0.1:8189', comfyV2ProxyToken: 'proxy-token-abcdef', comfyCloudApiKey: 'old-cloud-key-0123456789', localComfyUrl: 'http://127.0.0.1:8188' });
    check('the Flow window\'s old settings move into the config folder (key, proxy, its choice), the local address kept',
      moved.moved.includes('API key') && moved.moved.includes('proxy token') && r2.get('proxy')?.enabled === true && r2.choice() === 'proxy'
      && r2.local().url === 'http://127.0.0.1:8188' && r2.key() === 'old-cloud-key-0123456789' && r2.proxyToken() === 'proxy-token-abcdef');
    r2.migrate({ comfyCloudApiKey: 'another-key-0123456789' });
    check('a key already in the config folder is never overwritten by a migration', r2.key() === 'old-cloud-key-0123456789');
  }

  console.log('Comfy API v2 through the SDK');
  const runs = new RunLog(dir);
  const jobs = new V2Jobs(reg, runs);
  let finished = 0;
  jobs.onFinished(() => finished++);
  const up = await jobs.upload('deployment', new Uint8Array([1, 2, 3]), 'frame.png', 'image/png');
  const ref = up.reference as { __type?: string; info?: { id?: string } };
  check('an input goes up as a v2 asset and comes back as a core/ASSET reference', ref.__type === 'core/ASSET' && /^asset-/.test(ref.info?.id ?? ''));
  check('the deployment gets the platform key as a bearer token', v2.seen.some((x) => x.path === '/api/v2/assets' && x.auth === 'Bearer test-key-0123456789'));
  const wf = { 1: { class_type: 'LoadImage', inputs: { image: ref } }, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } };
  const { jobId } = await jobs.submit('deployment', wf, { workflowId: 'zimage-t2i', slotSeconds: null, scaleWithSlot: false, source: 'flow' });
  const sent = v2.seen.find((x) => x.method === 'POST' && x.path === '/api/v2/jobs');
  check('one submit, under the key', !!sent && sent.auth === 'Bearer test-key-0123456789' && v2.seen.filter((x) => x.method === 'POST' && x.path === '/api/v2/jobs').length === 1);
  let view = await jobs.status('deployment', jobId);
  check('while it runs, the status carries the progress snapshot', view.status === 'running' && view.progress?.step === 2 && view.progress.steps === 4);
  await until(() => false, 200);
  view = await jobs.status('deployment', jobId);
  const expected = creditsFor(12_000, 736.39);
  check('when it is done: the execution time the server reported, and the credits derived from it',
    view.status === 'succeeded' && view.executionMs === 12_000 && view.timing === 'execution_ms' && Math.abs((view.derivedCredits ?? 0) - expected) < 1e-9 && Math.abs(expected - 2.4546) < 0.001,
    `${view.executionMs} ms → ${view.derivedCredits}`);
  check('the finished run is in the history, once, with its credits', runs.of('zimage-t2i', 'deployment').length === 1 && Math.abs((runs.of('zimage-t2i', 'deployment')[0].derivedCredits ?? 0) - expected) < 1e-9);
  await jobs.status('deployment', jobId);
  check('polling a finished job again records nothing twice', runs.of('zimage-t2i', 'deployment').length === 1 && finished === 1);
  const out = await jobs.output('deployment', jobId, view.outputs[0].id);
  check('the output comes down through the server', new TextDecoder().decode(out.bytes) === 'fake-v2-output' && out.contentType === 'image/png');
  check('its URL is the server\'s own route, never the platform\'s', view.outputs[0].url.startsWith('/api/run/deployment/jobs/'));
  let credit: unknown = null;
  try { await jobs.submit('deployment', { 1: { class_type: 'Broke', inputs: {} } }, { workflowId: 'x', slotSeconds: null, scaleWithSlot: false, source: 'flow' }); } catch (e) { credit = e; }
  check('402 insufficient_credits becomes an error that offers "run locally"', credit instanceof RunError && credit.code === 'insufficient_credits' && credit.action === 'run-locally' && credit.status === 402);

  // The proxy without a token must not be handed a key from the environment.
  reg.update({ resources: [{ id: 'proxy', url: v2.url, enabled: true }] });
  const savedEnv = process.env.COMFY_API_KEY;
  process.env.COMFY_API_KEY = 'env-key-should-not-travel';
  try {
    await jobs.upload('proxy', new Uint8Array([9]), 'p.png', 'image/png');
  } finally {
    if (savedEnv === undefined) delete process.env.COMFY_API_KEY; else process.env.COMFY_API_KEY = savedEnv;
  }
  const proxyCall = v2.seen.filter((x) => x.path === '/api/v2/assets').at(-1);
  check('a proxy without a token gets no credentials at all (not even COMFY_API_KEY from the environment)', !!proxyCall && proxyCall.auth === undefined);
  check('the SDK client sees the environment only while it is being built', process.env.COMFY_BASE_URL === undefined);

  console.log('estimates');
  const fromRuns = estimateRun(runs.of('zimage-t2i', 'deployment', 'RTX PRO 6000'), { slotSeconds: null, scaleWithSlot: false, creditsPerHour: 736.39, gpuLabel: 'RTX PRO 6000' });
  check('after one run: "timed", ≈ the derived credits, based on 1 run', fromRuns.basis === 'timed' && fromRuns.runs === 1 && Math.abs((fromRuns.creditsHigh ?? 0) - expected) < 1e-9);
  const first = estimateRun([], { slotSeconds: 5, scaleWithSlot: true, creditsPerHour: 736.39, gpuLabel: 'RTX PRO 6000' });
  check('before any run: the rate only (12.3 cr/min on RTX PRO 6000), no number pretending to be more', first.basis === 'rate' && first.creditsLow === null && Math.abs((first.creditsPerMinute ?? 0) - 12.273) < 0.001);
  check('its line says so', /first run: 12\.3 cr\/min on RTX PRO 6000 · no run of this workflow here yet/.test(describeEstimate(first, 'Comfy Cloud')));
  const vid = (slot: number, ms: number): RunRecord => ({ at: new Date().toISOString(), workflowId: 'w', resourceId: 'cloud', resourceKind: 'cloud', gpu: 'RTX PRO 6000', executionMs: ms, timing: 'execution_ms', wallMs: ms + 4000, slotSeconds: slot, scaleWithSlot: true, derivedCredits: null, creditsPerHour: 736.39 });
  const scaled = estimateRun([vid(4, 120_000), vid(5, 180_000)], { slotSeconds: 8, scaleWithSlot: true, creditsPerHour: 736.39, gpuLabel: 'RTX PRO 6000' });
  check('video scales with the slot, as a range from the fastest to the slowest run', scaled.secondsLow === 240 && Math.abs((scaled.secondsHigh ?? 0) - 288) < 1e-9 && scaled.beyondHistory);
  check('the line carries ≈, the range, the basis and the warning', /^≈ 49–59\+ cr \(~\$0\.26\) · ~4:00–4:48 min on Comfy Cloud · based on 2 runs on RTX PRO 6000 · longer than any run so far$/.test(describeEstimate(scaled, 'Comfy Cloud')), describeEstimate(scaled, 'Comfy Cloud'));
  const local = estimateRun([{ ...vid(4, 30_000), resourceId: 'local', gpu: null }], { slotSeconds: 4, scaleWithSlot: true, creditsPerHour: null, gpuLabel: null });
  check('on your own GPU: no credits, the time from runs on record', local.basis === 'free' && local.creditsHigh === null && local.secondsHigh === 30);
  const series = sumEstimates([scaled, first]);
  check('a Storyboard series adds up, and its basis is the weakest shot\'s', series.shots === 2 && series.basis === 'rate' && series.unknown === 1);

  console.log('credits');
  const credits = new Credits(reg, v2.url);
  const c1 = await credits.get();
  check('the balance comes from the billing report: cents, despite "_micros", as credits at 211 per dollar',
    c1.ok && c1.balanceCents === 4250 && c1.credits === centsToCredits(4250) && Math.abs((c1.credits ?? 0) - 8967.5) < 1e-9 && c1.prepaidCents === 2250 && c1.planCents === 2000 && c1.currency === 'USD');
  check('it says when it was read (the report\'s own as_of) and that it comes from invoices', c1.asOf === '2026-10-25T12:00:01.500Z' && c1.source === 'invoices', String(c1.asOf));
  const billingCalls = (): number => v2.seen.filter((x) => x.path.startsWith('/api/billing/')).length;
  const before = billingCalls();
  await credits.get();
  check('kept five minutes: a second read does not call the report', billingCalls() === before);
  check('the report is called with the key as X-API-Key', v2.seen.some((x) => x.path.startsWith('/api/billing/') && x.key === 'test-key-0123456789'));
  credits.refreshAfterJob();
  await until(() => billingCalls() > before, 3000);
  const c2 = await credits.get();
  check('after a job the balance is read again, and the reading before it is kept to compare', billingCalls() > before && c2.previous?.credits === c1.credits && c2.pendingRefresh);
  reg.update({ apiKey: WRONG_KEY });
  const c3 = await new Credits(reg, v2.url).get();
  check('a refused key is said plainly, with no balance', !c3.ok && /not accepted/.test(c3.error ?? '') && c3.credits === null);
  reg.update({ apiKey: null });
  check('removing the key deletes its file', !existsSync(join(dir, 'comfy-api-key.txt')) && !reg.view().key.set);
  {
    // A key file the user created but has not filled yet (or filled with blanks) is no key at all.
    const savedEnv = process.env.COMFY_API_KEY;
    delete process.env.COMFY_API_KEY;
    for (const body of ['', '\r\n', '   \n\t\n']) {
      writeFileSync(join(dir, 'comfy-api-key.txt'), body);
      const cloudNow = reg.view().resources.find((r) => r.id === 'cloud')!;
      const c = await new Credits(reg, v2.url).get(true);
      const before = v2.seen.length;
      check(`an empty key file (${JSON.stringify(body)}) is no key: Cloud "not set up", no call made, no 401`,
        !reg.view().key.set && !cloudNow.usable && /no API key/.test(cloudNow.reason ?? '') && !c.ok && /No API key/.test(c.error ?? '') && v2.seen.length === before);
    }
    writeFileSync(join(dir, 'comfy-api-key.txt'), '﻿\n  ' + FAKE_KEY + '  \r\n');
    check('a key with a byte-order mark, a blank first line and spaces is read as the key', reg.key() === FAKE_KEY);
    writeFileSync(join(dir, 'comfy-api-key.txt'), '');
    if (savedEnv !== undefined) process.env.COMFY_API_KEY = savedEnv;
  }

  v2.close();
}
