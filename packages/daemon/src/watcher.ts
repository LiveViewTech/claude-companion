import path from "node:path";
import fs from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { parseLine } from "@ccc/core";
import { Tailer } from "./tailer.ts";
import type { SessionTracker } from "./session-tracker.ts";

export interface WatcherStats {
  files: number;
  lines: number;
  parseErrors: number;
  otherTypes: Record<string, number>;
}

/**
 * Watches ~/.claude/projects/**\/*.jsonl, backfills existing files once,
 * then streams appended lines into the SessionTracker.
 */
export class TranscriptWatcher {
  private tailer = new Tailer();
  private watcher: FSWatcher | null = null;
  readonly stats: WatcherStats = { files: 0, lines: 0, parseErrors: 0, otherTypes: {} };
  /** Files seen during initial scan get live=false ingestion up to their current size. */
  private backfilled = new Set<string>();

  private projectsDir: string;
  private tracker: SessionTracker;

  constructor(projectsDir: string, tracker: SessionTracker) {
    this.projectsDir = projectsDir;
    this.tracker = tracker;
  }

  async start(): Promise<void> {
    // 1) Backfill: parse all existing transcripts without firing timers/toasts.
    this.initialScan();
    // 2) Live watch. Polling keeps this robust on Windows/OneDrive/network drives;
    //    chokidar v4 uses native events where reliable. Subagent transcripts nest at
    //    <slug>/<session-id>/subagents/*.jsonl, so the depth limit must reach past 3.
    this.watcher = chokidar.watch(this.projectsDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      depth: 6,
    });
    this.watcher.on("add", (f) => this.onChange(f));
    this.watcher.on("change", (f) => this.onChange(f));
    this.watcher.on("unlink", (f) => this.tailer.forget(f));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private initialScan(): void {
    for (const f of this.findTranscripts(this.projectsDir)) {
      this.consume(f, false);
      this.backfilled.add(f);
    }
  }

  /**
   * All .jsonl under `dir`, recursively — session transcripts sit at depth 2
   * (<slug>/<session>.jsonl), subagent transcripts deeper
   * (<slug>/<session-id>/subagents/agent-*.jsonl). A dir's own files are
   * consumed before its subdirs so parent sessions ingest before their agents.
   */
  private findTranscripts(dir: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) subdirs.push(path.join(dir, e.name));
      else if (e.name.endsWith(".jsonl")) files.push(path.join(dir, e.name));
    }
    for (const d of subdirs) files.push(...this.findTranscripts(d));
    return files;
  }

  private onChange(file: string): void {
    if (!file.endsWith(".jsonl")) return;
    this.consume(file, true);
  }

  private consume(file: string, live: boolean): void {
    // Project slug = first path segment under projectsDir. basename(dirname)
    // would misname nested subagent transcripts as project "subagents".
    const rel = path.relative(this.projectsDir, file);
    const slug = rel.split(path.sep)[0] ?? path.basename(path.dirname(file));
    const lines = this.tailer.readNew(file);
    if (lines.length > 0 && this.tailer.offsetOf(file) > 0) this.stats.files = Math.max(this.stats.files, this.backfilled.size);
    for (const line of lines) {
      this.stats.lines++;
      const { entry, error } = parseLine(line);
      if (error) {
        this.stats.parseErrors++;
        continue;
      }
      if (!entry) continue;
      if (entry.kind === "other") {
        this.stats.otherTypes[entry.type] = (this.stats.otherTypes[entry.type] ?? 0) + 1;
        continue;
      }
      this.tracker.ingest(entry, slug, live);
    }
  }
}
