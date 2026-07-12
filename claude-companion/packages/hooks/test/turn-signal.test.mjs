import { describe, expect, it } from "vitest";
import path from "node:path";
import { classifyReason, defaultSound, parseWav, withLeadingSilence } from "../src/turn-signal.mjs";

/** Minimal valid PCM WAV with `dataBytes` of caller-supplied sample data. */
function makeWav(dataBytes, { channels = 2, sampleRate = 44100, bits = 16 } = {}) {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + dataBytes.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(byteRate, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(bits, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(dataBytes.length, 40);
  return Buffer.concat([head, dataBytes]);
}

describe("turn-signal hook", () => {
  it("maps Stop / SubagentStop to 'done'", () => {
    expect(classifyReason({ hook_event_name: "Stop" })).toBe("done");
    expect(classifyReason({ hook_event_name: "SubagentStop" })).toBe("done");
  });

  it("splits Notification into permission vs. question by message text", () => {
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" })).toBe("permission");
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude wants to run rm -rf" })).toBe("permission");
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude is waiting for your input" })).toBe("question");
  });

  it("maps PreToolUse on AskUserQuestion to 'question'", () => {
    expect(classifyReason({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" })).toBe("question");
    // A PreToolUse for any other tool should not ding as a question (matcher scopes it, but be defensive).
    expect(classifyReason({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBe("done");
  });

  it("maps PermissionRequest to 'permission'", () => {
    expect(classifyReason({ hook_event_name: "PermissionRequest", tool_name: "Bash" })).toBe("permission");
  });

  it("falls back to 'done' for unknown events", () => {
    expect(classifyReason({})).toBe("done");
    expect(classifyReason({ hook_event_name: "SomethingElse" })).toBe("done");
  });

  it("picks a distinct default sound per reason (basename check, platform-agnostic)", () => {
    const done = path.basename(defaultSound("done")).toLowerCase();
    const question = path.basename(defaultSound("question")).toLowerCase();
    const permission = path.basename(defaultSound("permission")).toLowerCase();
    expect(new Set([done, question, permission]).size).toBe(3);
  });

  it("prepends silence into a SINGLE stream, preserving the original samples exactly", () => {
    // 4410 stereo/16-bit frames of non-zero data ≈ 25ms of "sound".
    const data = Buffer.alloc(4410 * 4, 7);
    const src = makeWav(data);
    const out = withLeadingSilence(src, 1000); // +1000ms of silence

    // Header well-formed and self-consistent.
    expect(out.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.toString("ascii", 8, 12)).toBe("WAVE");
    expect(out.toString("ascii", 36, 40)).toBe("data");
    const dataLen = out.readUInt32LE(40);
    expect(out.length).toBe(44 + dataLen);
    expect(out.readUInt32LE(4)).toBe(36 + dataLen);

    // Format carried over from the source (stereo/44.1k/16).
    const p = parseWav(out);
    expect(p.fmt).toMatchObject({ audioFormat: 1, channels: 2, sampleRate: 44100, bits: 16 });

    // data = exactly 1000ms of silence, then the original bytes untouched.
    const lead = 176400; // byteRate (stereo/16-bit/44.1k = 44100*4) * 1s
    expect(dataLen).toBe(lead + data.length);
    expect(out.subarray(44, 44 + lead).every((b) => b === 0)).toBe(true);
    expect(Buffer.compare(out.subarray(44 + lead), data)).toBe(0);
  });

  it("returns null for non-PCM or non-WAV input", () => {
    expect(withLeadingSilence(Buffer.from("not a wav at all"), 500)).toBeNull();
    const adpcm = makeWav(Buffer.alloc(16, 1));
    adpcm.writeUInt16LE(2, 20); // audioFormat 2 = ADPCM, not PCM
    expect(withLeadingSilence(adpcm, 500)).toBeNull();
  });
});
