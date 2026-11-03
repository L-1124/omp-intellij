import { Transform } from 'node:stream';

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export type FrameHandler = (message: unknown, frame: Buffer) => void;

export function frameParser(onFrame: FrameHandler): (chunk: Buffer) => void {
  let header: Buffer = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let remaining: number | null = null;
  let length = 0;

  return (chunk: Buffer) => {
    while (chunk.length) {
      if (remaining === null) {
        const input = header.length ? Buffer.concat([header, chunk]) : chunk;
        const end = input.indexOf('\r\n\r\n');
        if (end < 0) {
          if (input.length > 8192) throw new Error('Invalid LSP header');
          header = input;
          return;
        }
        if (end > 8192) throw new Error('Invalid LSP header');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
          input.subarray(0, end).toString('ascii'),
        );
        length = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(length) || length < 1 || length > 64 * 1024 * 1024) {
          throw new Error('Invalid LSP frame length');
        }
        header = input.subarray(0, end + 4);
        remaining = length;
        chunk = input.subarray(end + 4);
      }
      const count = Math.min(remaining, chunk.length);
      if (count) parts.push(chunk.subarray(0, count));
      remaining -= count;
      chunk = chunk.subarray(count);
      if (remaining === 0) {
        const body = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
        const message: unknown = JSON.parse(body.toString('utf8'));
        const frame = Buffer.concat([header, body]);
        header = Buffer.alloc(0);
        parts = [];
        remaining = null;
        onFrame(message, frame);
      }
    }
  };
}

export function asyncFramedStream(
  onMessage: (message: unknown, frame: Buffer) => Promise<void> | void,
): Transform {
  let collected: Array<{ message: unknown; frame: Buffer }> = [];
  const parse = frameParser((message, frame) => {
    collected.push({ message, frame });
  });

  return new Transform({
    async transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ) {
      collected = [];
      try {
        parse(chunk);
      } catch (err: unknown) {
        return done(err instanceof Error ? err : new Error(String(err)));
      }
      try {
        for (const item of collected) {
          await onMessage(item.message, item.frame);
        }
        done();
      } catch (err: unknown) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
