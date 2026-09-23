import { writeSync } from 'node:fs';

// Linux pipe buffer. Anything that fits is delivered by the kernel even if the
// process exits right away; only the overflow sits in Bun's async writer.
const PIPE_BUFFER_BYTES = 65_536;

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

/**
 * `console.log` for output that fits in a pipe buffer (keeps the usual path,
 * including console.log capture in tests); synchronous write above that.
 */
export function logStdoutFully(text: string): void {
  if (Buffer.byteLength(text) < PIPE_BUFFER_BYTES) {
    console.log(text);
    return;
  }
  writeStdoutFully(text + '\n');
}
