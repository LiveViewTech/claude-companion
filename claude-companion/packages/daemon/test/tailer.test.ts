import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tailer } from "../src/tailer.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-tailer-"));
  file = path.join(dir, "t.jsonl");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Tailer", () => {
  it("reads only appended lines across calls", () => {
    const t = new Tailer();
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    expect(t.readNew(file)).toEqual(['{"a":1}', '{"a":2}']);
    expect(t.readNew(file)).toEqual([]);
    fs.appendFileSync(file, '{"a":3}\n');
    expect(t.readNew(file)).toEqual(['{"a":3}']);
  });

  it("buffers partial trailing lines until completed", () => {
    const t = new Tailer();
    fs.writeFileSync(file, '{"a":1}\n{"a":');
    expect(t.readNew(file)).toEqual(['{"a":1}']);
    fs.appendFileSync(file, '2}\n');
    expect(t.readNew(file)).toEqual(['{"a":2}']);
  });

  it("recovers from truncation by restarting at zero", () => {
    const t = new Tailer();
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    t.readNew(file);
    fs.writeFileSync(file, '{"b":1}\n'); // smaller file = truncated/rotated
    expect(t.readNew(file)).toEqual(['{"b":1}']);
  });

  it("handles missing files gracefully", () => {
    const t = new Tailer();
    expect(t.readNew(path.join(dir, "nope.jsonl"))).toEqual([]);
  });
});
