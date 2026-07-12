import { describe, expect, it } from "vitest";
import { parseLine } from "../src/transcript-adapter.ts";

// Sanitized fixtures matching the real Claude Code 2.1.x on-disk shape.
const ASSISTANT_LINE = JSON.stringify({
  parentUuid: "p-1",
  isSidechain: false,
  message: {
    model: "claude-fable-5",
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status", description: "Show status" }, caller: "assistant" },
    ],
    stop_reason: null,
    usage: {
      input_tokens: 301,
      cache_creation_input_tokens: 1098,
      cache_read_input_tokens: 335468,
      output_tokens: 1737,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1098 },
      server_tool_use: { web_search_requests: 0 },
    },
  },
  requestId: "req_1",
  type: "assistant",
  uuid: "a-1",
  timestamp: "2026-06-26T00:23:15.125Z",
  cwd: "C:\\Users\\dev\\src\\sample-project",
  sessionId: "sess-1",
  version: "2.1.207",
  gitBranch: "main",
});

const USER_TOOLRESULT_LINE = JSON.stringify({
  parentUuid: "a-1",
  isSidechain: false,
  type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "On branch main\nnothing to commit" }] },
  uuid: "u-1",
  timestamp: "2026-06-26T00:23:20.000Z",
  toolUseResult: "On branch main\nnothing to commit",
  sessionId: "sess-1",
  version: "2.1.207",
});

const HUMAN_PROMPT_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "please fix the failing test" },
  uuid: "u-2",
  timestamp: "2026-06-26T00:25:00.000Z",
  sessionId: "sess-1",
});

describe("transcript adapter", () => {
  it("parses assistant turns with usage, model, tool uses", () => {
    const { entry, error } = parseLine(ASSISTANT_LINE);
    expect(error).toBeUndefined();
    if (entry?.kind !== "assistant") throw new Error("expected assistant");
    expect(entry.uuid).toBe("a-1");
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.model).toBe("claude-fable-5");
    expect(entry.usage?.cache_read_input_tokens).toBe(335468);
    expect(entry.usage?.cache_creation?.ephemeral_1h_input_tokens).toBe(1098);
    expect(entry.toolUses).toEqual([{ id: "toolu_1", name: "Bash", command: "git status" }]);
    expect(entry.version).toBe("2.1.207");
  });

  it("parses user tool-result entries with sizes", () => {
    const { entry } = parseLine(USER_TOOLRESULT_LINE);
    if (entry?.kind !== "user") throw new Error("expected user");
    expect(entry.isHumanPrompt).toBe(false);
    expect(entry.toolResults).toHaveLength(1);
    expect(entry.toolResults[0]?.toolUseId).toBe("toolu_1");
    expect(entry.toolResults[0]?.resultChars).toBeGreaterThan(10);
  });

  it("recognizes human prompts", () => {
    const { entry } = parseLine(HUMAN_PROMPT_LINE);
    if (entry?.kind !== "user") throw new Error("expected user");
    expect(entry.isHumanPrompt).toBe(true);
    expect(entry.promptChars).toBeGreaterThan(0);
  });

  it("maps unknown types to 'other' without failing", () => {
    const { entry } = parseLine(JSON.stringify({ type: "file-history-snapshot", ts: 1 }));
    expect(entry?.kind).toBe("other");
    if (entry?.kind === "other") expect(entry.type).toBe("file-history-snapshot");
  });

  it("never throws on garbage", () => {
    expect(parseLine("not json").entry).toBeNull();
    expect(parseLine("not json").error).toMatch(/json/);
    expect(parseLine("42").error).toBeDefined();
    expect(parseLine("").entry).toBeNull();
    // assistant with missing message/usage still parses
    const { entry } = parseLine(JSON.stringify({ type: "assistant", uuid: "x", sessionId: "s", timestamp: "t" }));
    expect(entry?.kind).toBe("assistant");
  });
});
