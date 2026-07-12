import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Server } from "../src/server.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-server-"));
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
  server = new Server(tracker, store, 0); // 0 => ephemeral port
});
afterEach(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function postTurn(body: Record<string, unknown>): Promise<{ ok: boolean; flashed: boolean }> {
  const r = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as { ok: boolean; flashed: boolean };
}

describe("POST /turn", () => {
  it("flashes once per session within the debounce window, again for another session", async () => {
    server.turnSignal = { flashColor: "#fff", flashMs: 200 };
    await server.listen();
    base = `http://127.0.0.1:${server.boundPort}`;

    expect(await postTurn({ session_id: "a", reason: "done" })).toMatchObject({ ok: true, flashed: true });
    // Second hit for the same session (Stop + Notification burst) is debounced.
    expect(await postTurn({ session_id: "a", reason: "permission" })).toMatchObject({ ok: true, flashed: false });
    // A different session is independent.
    expect(await postTurn({ session_id: "b", reason: "done" })).toMatchObject({ ok: true, flashed: true });
  });

  it("does not flash when the turn signal is disabled (turnSignal null)", async () => {
    server.turnSignal = null;
    await server.listen();
    base = `http://127.0.0.1:${server.boundPort}`;
    expect(await postTurn({ session_id: "a", reason: "done" })).toMatchObject({ ok: true, flashed: false });
  });
});
