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
    //    chokidar v4 uses native events where reliable.
    this.watcher = chokidar.watch(this.projectsDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      depth: 3,
    });
    this.watcher.on("add", (f) => this.onChange(f));
    this.watcher.on("change", (f) => this.onChange(f));
    this.watcher.on("unlink", (f) => this.tailer.forget(f));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private initialScan(): void {
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.projectsDir, d.name));
    } catch {
      return;
    }
    for (const dir of dirs) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
      } catch {
        continue;
      }
      for (const f of files) {
        this.consume(f, false);
        this.backfilled.add(f);
      }
    }
  }

  private onChange(file: string): void {
    if (!file.endsWith(".jsonl")) return;
    this.consume(file, true);
  }

  private consume(file: string, live: boolean): void {
    const slug = path.basename(path.dirname(file));
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
