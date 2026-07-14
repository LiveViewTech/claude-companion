import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { TranscriptWatcher } from "../src/watcher.ts";

let dir: string;
let projects: string;
let store: Store;
let tracker: SessionTracker;
let watcher: TranscriptWatcher;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-watcher-"));
  projects = path.join(dir, "projects");
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
  watcher = new TranscriptWatcher(projects, tracker);
});
afterEach(async () => {
  await watcher.stop();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function assistantLine(opts: { uuid: string; sessionId: string; requestId: string; sidechain?: boolean }): string {
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid,
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    timestamp: "2026-07-11T10:00:00.000Z",
    isSidechain: opts.sidechain ?? false,
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

describe("TranscriptWatcher backfill", () => {
  it("ingests nested subagent transcripts and attributes them to the parent session", async () => {
    // Session transcript at the usual depth, subagent transcript nested below it.
    const slugDir = path.join(projects, "c--repo");
    const subagentsDir = path.join(slugDir, "sess-1", "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "sess-1.jsonl"), assistantLine({ uuid: "m1", sessionId: "sess-1", requestId: "req-main" }) + "\n");
    fs.writeFileSync(
      path.join(subagentsDir, "agent-abc.jsonl"),
      assistantLine({ uuid: "a1", sessionId: "sess-1", requestId: "req-agent", sidechain: true }) + "\n",
    );

    await watcher.start();

    const turns = store.db.prepare("SELECT uuid, session_id, is_sidechain FROM turns ORDER BY uuid").all() as Array<{
      uuid: string;
      session_id: string;
      is_sidechain: number;
    }>;
    expect(turns).toEqual([
      { uuid: "req-agent", session_id: "sess-1", is_sidechain: 1 },
      { uuid: "req-main", session_id: "sess-1", is_sidechain: 0 },
    ]);
    // Slug comes from the first path segment, not the immediate parent dir ("subagents").
    const session = store.db.prepare("SELECT project_slug FROM sessions WHERE id = 'sess-1'").get() as { project_slug: string };
    expect(session.project_slug).toBe("c--repo");
  });
});
