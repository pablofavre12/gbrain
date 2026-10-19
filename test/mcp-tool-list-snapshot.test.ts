/**
 * Stdio initialize + tools/list byte-identity: the server builds both from
 * src/core/operation-manifest.generated.ts instead of loading every handler
 * module. Each mode boots the real startMcpServer twice — once as shipped and
 * once with the manifest swapped for the live operations registry
 * (test/fixtures/mcp-stdio-list-driver.ts) — and requires the two initialize
 * results and tools/list results to match byte for byte. Editing an op
 * without `bun run build:operation-manifest` fails here (and in
 * test/operation-manifest.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const DRIVER = join(REPO_ROOT, 'test', 'fixtures', 'mcp-stdio-list-driver.ts');
const CHILD_STRIP = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'GBRAIN_SURFACE', 'GBRAIN_MCP_FORCE_SURFACE', 'GBRAIN_MCP_INSTRUCTIONS'];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Mode { name: string; surface?: 'verbs' | 'starter' | 'full'; access?: 'read-only'; mcp?: Record<string, unknown> }

const MODES: Mode[] = [
  { name: 'default (full)' },
  { name: 'starter, strict params', surface: 'starter', mcp: { strict_params: 'reject' } },
  { name: 'verbs', surface: 'verbs' },
  { name: 'full, read-only access', access: 'read-only' },
  { name: 'full, both publish gates on, strict params', mcp: { publish_skills: true, publish_advisor: true, strict_params: 'reject' } },
  { name: 'full, advisor gate off, advertised starter', mcp: { publish_advisor: false, advertised_surface: 'starter' } },
];

async function handshake(mode: Mode, eager: boolean): Promise<{ initialize: string; tools: string }> {
  const parent = mkdtempSync(join(tmpdir(), 'gb-snap-'));
  dirs.push(parent);
  mkdirSync(join(parent, '.gbrain'), { recursive: true });
  writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', database_path: join(parent, 'db'), embedding_dimensions: 1536, ...(mode.mcp ? { mcp: mode.mcp } : {}),
  }));
  const env = { ...process.env } as Record<string, string>;
  for (const k of CHILD_STRIP) delete env[k];
  Object.assign(env, {
    GBRAIN_HOME: parent, HOME: parent, GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SERVE_SYNC_IPC: '0',
    SNAP_EAGER: eager ? '1' : '0', SNAP_SURFACE: mode.surface ?? '', SNAP_ACCESS: mode.access ?? '',
  });
  const proc = Bun.spawn([process.execPath, DRIVER], { cwd: parent, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const started = Date.now();
  let stderrBytes = 0;
  let stderrTail = Buffer.alloc(0);
  let readerError: unknown;
  const stderrReader = (async () => {
    for await (const chunk of proc.stderr) {
      stderrBytes += chunk.byteLength;
      stderrTail = Buffer.from(Buffer.concat([stderrTail, chunk]).subarray(-65_536));
    }
  })().catch(error => { readerError = error; });
  const responses = new Map<number, string>();
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (typeof msg.id === 'number') responses.set(msg.id, JSON.stringify(msg.result ?? msg.error));
      }
    }
  })().catch(error => { readerError = error; });
  const diagnostic = (id: number) => `${mode.name}, ${eager ? 'eager' : 'manifest'}, response=${id}, elapsed=${Date.now() - started}ms, exit=${proc.exitCode}, stderrBytes=${stderrBytes}\n${stderrTail.toString('utf8')}`;
  const send = (msg: unknown) => { proc.stdin.write(JSON.stringify(msg) + '\n'); proc.stdin.flush(); };
  const waitFor = async (id: number) => {
    const deadline = Date.now() + 60_000;
    while (!responses.has(id)) {
      if (readerError) throw new Error(`driver stream failed: ${String(readerError)}; ${diagnostic(id)}`);
      if (proc.exitCode !== null) throw new Error(`driver exited: ${diagnostic(id)}`);
      if (Date.now() > deadline) throw new Error(`no response: ${diagnostic(id)}`);
      await Bun.sleep(10);
    }
    if (readerError) throw new Error(`driver stream failed: ${String(readerError)}; ${diagnostic(id)}`);
    return responses.get(id)!;
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snapshot', version: '0' } } });
    const initialize = await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await waitFor(2);
    return { initialize, tools };
  } finally {
    proc.kill('SIGKILL');
    await proc.exited;
    await Promise.all([reader, stderrReader]);
    if (readerError) throw new Error(`driver stream failed: ${String(readerError)}; ${diagnostic(2)}`);
  }
}

type Pair = { manifest: { initialize: string; tools: string }; eager: { initialize: string; tools: string } };
let results: Pair[] = [];
beforeAll(async () => {
  results = [];
  // Each pair compares the same real server paths. Twelve simultaneous cold
  // PGLite boots can exhaust a small runner before any handshake responds.
  for (const mode of MODES) {
    const pair = await Promise.allSettled([handshake(mode, false), handshake(mode, true)]);
    const [manifest, eager] = pair;
    if (manifest.status === 'rejected') throw manifest.reason;
    if (eager.status === 'rejected') throw eager.reason;
    results.push({ manifest: manifest.value, eager: eager.value });
  }
}, 180_000);

describe('stdio initialize + tools/list: manifest path == eager registry path', () => {
  MODES.forEach((mode, i) => {
    test(mode.name, () => {
      const { manifest, eager } = results[i];
      expect(JSON.parse(manifest.tools).tools.length).toBeGreaterThan(0);
      expect(manifest.tools).toBe(eager.tools);
      expect(manifest.initialize).toBe(eager.initialize);
    });
  });
  test('every mode lists a different tool set (the matrix is not degenerate)', () => {
    expect(new Set(results.map(r => r.manifest.tools)).size).toBe(MODES.length);
  });
});
