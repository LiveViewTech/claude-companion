import type { AssistantTurn, Entry, ParseResult, ToolResultInfo, ToolUse, Usage } from "./types.ts";

/**
 * Tolerant parser for Claude Code transcript JSONL lines.
 *
 * The schema is officially internal and unstable, so this adapter:
 *  - never throws (bad lines -> { entry: null, error }),
 *  - treats every field as optional and validates types manually (no hard schema),
 *  - maps unknown entry types to kind "other" so callers can count drift.
 *
 * Verified against Claude Code 2.1.x transcripts (2026-07).
 */
export function parseLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { entry: null };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    return { entry: null, error: `json: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null) return { entry: null, error: "non-object line" };
  const o = raw as Record<string, unknown>;
  const type = str(o["type"]) ?? "unknown";

  try {
    if (type === "assistant") return { entry: parseAssistant(o) };
    if (type === "user") return { entry: parseUser(o) };
    return {
      entry: { kind: "other", type, timestamp: str(o["timestamp"]), sessionId: str(o["sessionId"]) },
    };
  } catch (e) {
    return { entry: null, error: `adapter: ${(e as Error).message}` };
  }
}

function parseAssistant(o: Record<string, unknown>): AssistantTurn {
  const message = obj(o["message"]) ?? {};
  const usage = parseUsage(obj(message["usage"]));
  const content = Array.isArray(message["content"]) ? (message["content"] as unknown[]) : [];
  const toolUses: ToolUse[] = [];
  for (const block of content) {
    const b = obj(block);
    if (!b || b["type"] !== "tool_use") continue;
    const id = str(b["id"]);
    const name = str(b["name"]);
    if (!id || !name) continue;
    const input = obj(b["input"]);
    const command = input ? str(input["command"]) : undefined;
    toolUses.push({ id, name, ...(command !== undefined ? { command } : {}) });
  }
  return {
    kind: "assistant",
    uuid: str(o["uuid"]) ?? cryptoFallbackId(o),
    // Bill per API request: prefer the top-level requestId, fall back to the
    // response message.id. Both are stable across a turn's repeated tool-round lines.
    requestId: str(o["requestId"]) ?? str(message["id"]),
    sessionId: str(o["sessionId"]) ?? "",
    timestamp: str(o["timestamp"]) ?? "",
    model: str(message["model"]),
    usage,
    toolUses,
    cwd: str(o["cwd"]),
    version: str(o["version"]),
    isSidechain: bool(o["isSidechain"]),
  };
}

function parseUser(o: Record<string, unknown>): Entry {
  const message = obj(o["message"]) ?? {};
  const content = message["content"];
  const toolResults: ToolResultInfo[] = [];
  let promptChars = 0;
  let hasText = false;

  if (typeof content === "string") {
    promptChars = content.length;
    hasText = content.trim().length > 0;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = obj(block);
      if (!b) continue;
      if (b["type"] === "tool_result") {
        const toolUseId = str(b["tool_use_id"]);
        if (toolUseId) toolResults.push({ toolUseId, resultChars: contentChars(b["content"]) });
      } else if (b["type"] === "text") {
        const t = str(b["text"]) ?? "";
        promptChars += t.length;
        if (t.trim()) hasText = true;
      }
    }
  }

  return {
    kind: "user",
    uuid: str(o["uuid"]) ?? cryptoFallbackId(o),
    sessionId: str(o["sessionId"]) ?? "",
    timestamp: str(o["timestamp"]) ?? "",
    toolResults,
    isHumanPrompt: hasText && toolResults.length === 0,
    promptChars,
    cwd: str(o["cwd"]),
  };
}

function parseUsage(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  const usage: Usage = {
    input_tokens: num(u["input_tokens"]) ?? 0,
    output_tokens: num(u["output_tokens"]) ?? 0,
    cache_creation_input_tokens: num(u["cache_creation_input_tokens"]) ?? 0,
    cache_read_input_tokens: num(u["cache_read_input_tokens"]) ?? 0,
  };
  const cc = obj(u["cache_creation"]);
  if (cc) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: num(cc["ephemeral_5m_input_tokens"]),
      ephemeral_1h_input_tokens: num(cc["ephemeral_1h_input_tokens"]),
    };
  }
  return usage;
}

function contentChars(c: unknown): number {
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) {
    let n = 0;
    for (const block of c) {
      const b = obj(block);
      if (b && typeof b["text"] === "string") n += (b["text"] as string).length;
    }
    return n;
  }
  return 0;
}

// -- tiny coercion helpers ---------------------------------------------------
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
/** Deterministic-enough id for entries missing uuid (keeps upserts idempotent per content). */
function cryptoFallbackId(o: Record<string, unknown>): string {
  const basis = `${str(o["timestamp"]) ?? ""}|${str(o["sessionId"]) ?? ""}|${str(o["requestId"]) ?? ""}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) | 0;
  return `noid-${(h >>> 0).toString(16)}`;
}
