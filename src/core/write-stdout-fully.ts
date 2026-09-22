import { writeSync } from 'node:fs';

/**
 * Write `text` to fd 1 synchronously, retrying on EAGAIN, so large payloads
 * survive the CLI's timed exit. Bun's async stdout writer drops whatever is
 * still queued when the process exits — `check-update --json` (~450KB of
 * changelog) arrived cut at the 64KB pipe buffer on Linux CI. Gives up after
 * `timeoutMs` so an abandoned reader can't hang the process.
 */
export function writeStdoutFully(text: string, timeoutMs = 10_000): void {
  const buf = Buffer.from(text);
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' || Date.now() > deadline) throw err;
      Bun.sleepSync(1);
    }
  }
}
