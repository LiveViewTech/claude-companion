import fs from "node:fs";

/**
 * Incremental JSONL tailer: tracks a byte offset per file, reads only appended
 * bytes, buffers partial trailing lines, and tolerates truncation/rotation
 * (offset > file size -> restart from 0).
 */
export class Tailer {
  private offsets = new Map<string, number>();
  private partial = new Map<string, string>();

  /** Read new complete lines appended to `file` since the last call. */
  readNew(file: string): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.offsets.delete(file);
      this.partial.delete(file);
      return [];
    }
    let offset = this.offsets.get(file) ?? 0;
    if (stat.size < offset) {
      // truncated/rotated
      offset = 0;
      this.partial.set(file, "");
    }
    if (stat.size === offset) return [];

    const length = stat.size - offset;
    const buf = Buffer.allocUnsafe(length);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return [];
    }
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offsets.set(file, offset + bytesRead);

    const text = (this.partial.get(file) ?? "") + buf.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");
    // Last element is either "" (text ended with \n) or a partial line.
    this.partial.set(file, lines.pop() ?? "");
    return lines.filter((l) => l.length > 0);
  }

  /** Forget a file (deleted or no longer watched). */
  forget(file: string): void {
    this.offsets.delete(file);
    this.partial.delete(file);
  }

  offsetOf(file: string): number {
    return this.offsets.get(file) ?? 0;
  }
}
