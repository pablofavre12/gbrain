import { describe, expect, test } from 'bun:test';
import { logStdoutFully } from '../src/core/write-stdout-fully.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SIZE = 450_000;

// A reader that stalls fills the kernel pipe (64KB), which is what exposes
// Bun's async stdout writer dropping queued bytes on a timed process.exit —
// the same exit pattern the CLI uses (flushThenExit's grace timer).
function childScript(writer: 'fully' | 'async' = 'fully'): string {
  const write = writer === 'fully'
    ? `const { writeStdoutFully } = await import('./src/core/write-stdout-fully.ts'); writeStdoutFully(payload);`
    : `process.stdout.write(payload);`;
  return `const payload = 'x'.repeat(${SIZE}) + '\\n'; ${write} setTimeout(() => process.exit(0), 100);`;
}

async function bytesThroughStalledPipe(writer: 'fully' | 'async'): Promise<number> {
  const script = childScript(writer).replace(/'/g, `'\\''`);
  const proc = Bun.spawn(['sh', '-c', `bun -e '${script}' | (sleep 0.4; wc -c)`], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim());
}

describe('writeStdoutFully', () => {
  // Same harness with plain process.stdout.write delivers only ~65536 bytes
  // (verified on macOS and the Linux CI runner); not asserted, since it pins
  // a Bun bug rather than our behavior.
  test('delivers a large payload through a stalled pipe before a timed exit', async () => {
    expect(await bytesThroughStalledPipe('fully')).toBe(SIZE + 1);
  });
});

describe('logStdoutFully', () => {
  test('small output goes through console.log (keeps log capture working)', () => {
    const realLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      logStdoutFully('{"ok":true}');
    } finally {
      console.log = realLog;
    }
    expect(lines).toEqual(['{"ok":true}']);
  });
});
