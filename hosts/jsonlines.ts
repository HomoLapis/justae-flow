/**
 * A JSON-lines request/response client over loopback TCP — the shape of both
 * EffectCraft's and PhotoCraft's control channels: one JSON object per line,
 * `{id, method, params}` out, `{id, ok, result | error}` back, in order.
 *
 * One persistent connection, reopened on demand. Requests are serialised so a
 * slow command never interleaves with the next one.
 */

import net from 'node:net';
import { HostError } from './types.ts';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonLinesClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly host: string;
  private readonly port: number;
  private readonly label: string;
  /** Sent as the first frame of every new connection (PhotoCraft's bearer token). */
  private readonly hello: (() => { method: string; params: unknown } | null) | null;

  constructor(opts: { port: number; label: string; host?: string; hello?: () => { method: string; params: unknown } | null }) {
    this.port = opts.port;
    this.label = opts.label;
    this.host = opts.host ?? '127.0.0.1';
    this.hello = opts.hello ?? null;
  }

  private open(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const fail = (e: Error): void => {
        this.connecting = null;
        reject(new HostError(
          `${this.label} is not answering on ${this.host}:${this.port} (${(e as NodeJS.ErrnoException).code ?? e.message}). `
          + `Start it with its control channel enabled.`, true));
      };
      s.once('error', fail);
      s.once('connect', async () => {
        s.off('error', fail);
        s.setNoDelay(true);
        s.on('data', (d) => this.onData(d));
        s.on('close', () => this.onClose());
        s.on('error', () => { /* close follows */ });
        try {
          // The first frame of a connection (an auth token) must succeed before anything else is sent.
          const h = this.hello?.();
          if (h) await this.raw(s, h.method, h.params, 10_000);
        } catch (e) {
          this.connecting = null;
          s.destroy();
          reject(e instanceof Error ? e : new HostError(String(e)));
          return;
        }
        this.sock = s;
        this.connecting = null;
        resolve(s);
      });
    });
    return this.connecting;
  }

  private onData(d: Buffer): void {
    this.buf += d.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new HostError(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
    }
  }

  private onClose(): void {
    this.sock = null;
    this.buf = '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HostError(`${this.label} closed the connection.`, true));
    }
    this.pending.clear();
  }

  private raw(s: net.Socket, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError(`${this.label} did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      s.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** One request, after every request sent before it has been answered. */
  call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 65_000): Promise<T> {
    const run = async (): Promise<T> => this.raw(await this.open(), method, params, timeoutMs) as Promise<T>;
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }
}
