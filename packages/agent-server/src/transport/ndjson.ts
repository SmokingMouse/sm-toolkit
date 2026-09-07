/** Shared framing for both ends of a unix socket. Decode only complete UTF-8 lines. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class NDJSONDecoder {
  private chunks: Buffer[] = [];
  private length = 0;
  constructor(private readonly onLine: (line: string) => void, private readonly maxBytes = MAX_MESSAGE_BYTES) {}
  push(data: Buffer): void {
    let start = 0;
    for (;;) {
      const end = data.indexOf(10, start);
      const part = data.subarray(start, end < 0 ? data.length : end);
      this.length += part.length;
      if (this.length > this.maxBytes) throw new Error("NDJSON message exceeds size limit");
      if (part.length) this.chunks.push(Buffer.from(part));
      if (end < 0) return;
      const line = Buffer.concat(this.chunks, this.length).toString("utf8");
      this.chunks = []; this.length = 0;
      this.onLine(line);
      start = end + 1;
    }
  }
}

/** Bun.write is unbuffered: retain the unaccepted suffix until drain, in wire order. */
export class UnixWriter {
  private queue: Buffer[] = [];
  private bytes = 0;
  private ending = false;
  private closed = false;
  constructor(private readonly socket: Pick<Bun.Socket, "write" | "end">, private readonly maxBytes = 32 * 1024 * 1024) {}
  send(text: string): void {
    if (this.closed || this.ending) throw new Error("socket closed");
    const data = Buffer.from(text + "\n");
    if (this.bytes + data.length > this.maxBytes) throw new Error("slow consumer exceeded output buffer");
    this.queue.push(data); this.bytes += data.length; this.drain();
  }
  drain(): void {
    if (this.closed) return;
    while (this.queue.length) {
      const data = this.queue[0];
      const written = this.socket.write(data);
      if (written < 0) throw new Error("socket closed during write");
      this.bytes -= written;
      if (written < data.length) { this.queue[0] = data.subarray(written); return; }
      this.queue.shift();
    }
    if (this.ending) { this.closed = true; this.socket.end(); }
  }
  end(): void { this.ending = true; this.drain(); }
  dispose(): void { this.closed = true; this.queue = []; this.bytes = 0; }
}
