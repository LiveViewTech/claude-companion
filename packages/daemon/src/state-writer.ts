import fs from "node:fs";
import path from "node:path";
import type { SessionState } from "@ccc/core";

/**
 * Atomically writes per-session state JSON files that the statusline script
 * and hooks read. Write-to-temp + rename keeps readers from seeing torn files.
 */
export class StateWriter {
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
  }

  sessionFile(sessionId: string): string {
    return path.join(this.stateDir, "sessions", `${sanitize(sessionId)}.json`);
  }

  writeSession(state: SessionState): void {
    this.writeAtomic(this.sessionFile(state.sessionId), JSON.stringify(state));
  }

  writeGlobal(global: unknown): void {
    this.writeAtomic(path.join(this.stateDir, "global.json"), JSON.stringify(global));
  }

  /** Read back a session state file (used to merge courier fields written by the statusline). */
  readSession(sessionId: string): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile(sessionId), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private writeAtomic(file: string, data: string): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse rename over an open file; fall back to direct write.
      try {
        fs.writeFileSync(file, data);
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
