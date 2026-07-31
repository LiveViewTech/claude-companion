import { describe, expect, it } from "vitest";
import path from "node:path";
import { classifyReason, defaultSound, linuxPlayer, linuxThemeSound, parseWav, renderChime, withLeadingSilence } from "../src/turn-signal.mjs";

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

describe("linux player selection", () => {
  const has = (...bins) => (b) => bins.includes(b);

  // The bug this guards: aplay has no Ogg decoder and silently falls back to RAW playback,
  // so `aplay complete.oga` renders compressed bytes as samples -> seconds of static.
  it("never hands a compressed file to a WAV-only player", () => {
    expect(linuxPlayer("/usr/share/sounds/freedesktop/stereo/complete.oga", has("aplay"))).toBeNull();
    expect(linuxPlayer("/tmp/ccc-done.wav", has("aplay"))).toEqual({ cmd: "aplay", args: ["-q", "/tmp/ccc-done.wav"] });
  });

  it("picks pw-play on a PipeWire box with no pulseaudio-utils", () => {
    const p = linuxPlayer("/s/complete.oga", has("pw-play", "aplay"));
    expect(p).toEqual({ cmd: "pw-play", args: ["/s/complete.oga"] });
  });

  it("prefers paplay over later decoders, and falls through to ones that are installed", () => {
    expect(linuxPlayer("/s/a.oga", has("paplay", "mpv")).cmd).toBe("paplay");
    expect(linuxPlayer("/s/a.oga", has("mpv", "cvlc")).cmd).toBe("mpv");
    expect(linuxPlayer("/s/a.oga", has("cvlc")).cmd).toBe("cvlc");
  });

  it("returns null when nothing is installed", () => {
    expect(linuxPlayer("/s/a.wav", () => false)).toBeNull();
  });
});

describe("linux sound fallbacks", () => {
  it("walks themes and extensions, preferring the first reason-appropriate event", () => {
    const present = new Set(["/usr/share/sounds/Yaru/stereo/complete.oga"]);
    expect(linuxThemeSound("done", (f) => present.has(f))).toBe("/usr/share/sounds/Yaru/stereo/complete.oga");
    expect(linuxThemeSound("question", (f) => present.has(f))).toBe("");
  });

  it("synthesizes a playable PCM WAV when no sound theme is installed", () => {
    const buf = renderChime([{ startMs: 0, freq: 880, ms: 200 }, { startMs: 100, freq: 1320, ms: 300 }]);
    const p = parseWav(buf);
    expect(p.fmt).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 44100, bits: 16 });
    // ~440ms of audio (last note end + 40ms tail), and it is not silence.
    expect(p.dataLen / (44100 * 2)).toBeCloseTo(0.44, 1);
    expect(buf.subarray(p.dataOff, p.dataOff + p.dataLen).some((b) => b !== 0)).toBe(true);
    // Peak stays inside the headroom the renderer promises.
    let peak = 0;
    for (let i = p.dataOff; i + 1 < p.dataOff + p.dataLen; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    expect(peak).toBeLessThanOrEqual(Math.round(0.6 * 32767) + 1);
    expect(peak).toBeGreaterThan(1000);
  });
});
