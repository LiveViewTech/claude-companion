/** Cache TTL tier as observed in transcript usage data. */
export type TtlTier = "5m" | "1h";

/** Raw usage block as written by Claude Code into transcript JSONL (subset we rely on). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Per-TTL breakdown of cache writes. Present in current schema; treat as optional. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /**
   * Which speed tier actually served the request ("standard" | "fast"), as reported by
   * the API rather than requested by the client. Fast mode bills input and output at a
   * premium (Opus 5 / 4.8: $10/$50 against $5/$25), so a turn costed without this reads
   * half of what it cost. Kept as a bare string: an unrecognized tier must not throw.
   */
  speed?: string;
  /**
   * Where inference ran ("global" | "us"). US-only inference bills 1.1x across every
   * category on Claude 4.6+. Also a bare string, for the same reason.
   */
  inference_geo?: string;
}

export interface ToolUse {
  id: string;
  name: string;
  /** For Bash tools: the command string, when extractable. */
  command?: string;
}

export interface ToolResultInfo {
  toolUseId: string;
  /** Size of the result content in characters (proxy for context burn). */
  resultChars: number;
}

/** Normalized transcript entry. Anything unrecognized becomes kind "other". */
export type Entry =
  | AssistantTurn
  | UserEntry
  | OtherEntry;

export interface AssistantTurn {
  kind: "assistant";
  uuid: string;
  /**
   * Stable per-API-request id (Claude Code `requestId`, falling back to the
   * assistant `message.id`). Claude Code logs ONE billed response as several
   * assistant lines — one per tool-call round — each with a distinct `uuid`
   * but the SAME `requestId` and the SAME cumulative `usage`. Billing must be
   * keyed on this, not `uuid`, or a turn with N tool rounds is counted N times.
   */
  requestId?: string;
  sessionId: string;
  timestamp: string; // ISO
  model?: string;
  usage?: Usage;
  toolUses: ToolUse[];
  cwd?: string;
  version?: string;
  isSidechain?: boolean;
}

export interface UserEntry {
  kind: "user";
  uuid: string;
  sessionId: string;
  timestamp: string;
  toolResults: ToolResultInfo[];
  cwd?: string;
  /** True when this is a real human prompt (has plain text content, no tool results). */
  isHumanPrompt: boolean;
  promptChars: number;
  /** First PROMPT_TEXT_CAP chars of a human prompt's text (for session naming). */
  promptText?: string;
  isSidechain?: boolean;
}

export interface OtherEntry {
  kind: "other";
  type: string;
  timestamp?: string;
  sessionId?: string;
}

/** Result of parsing one JSONL line. */
export interface ParseResult {
  entry: Entry | null;
  /** Field names we did not recognize at the top level (schema-drift canary). */
  error?: string;
}

/** Live per-session state, written atomically for statusline/hooks to consume. */
export interface SessionState {
  sessionId: string;
  projectSlug: string;
  cwd?: string;
  model?: string;
  ccVersion?: string;
  /** Short human-readable session name (LLM-summarized from the user's prompts). */
  name?: string;
  /** Longer description of the session's intent, updated as it evolves. */
  nameDescription?: string;
  /** TTL tier of the most recent cache write. */
  ttlTier: TtlTier | null;
  /**
   * Premium billing modifiers seen on the latest turn. Every forward-looking projection
   * (re-write cost, prefix tax, keep-warm break-even) is quoted at these rates, because a
   * session running fast mode pays the fast rate for its next cache write too.
   */
  rateMods: RateMods;
  /** Epoch ms when the cache expires (last activity + TTL). Null when unknown. */
  expiresAt: number | null;
  /** Epoch ms of the last assistant turn with usage. */
  lastTurnAt: number | null;
  /** Approximate cacheable prefix size in tokens. */
  prefixTokens: number;
  /** Cost to re-write the prefix cold at current tier/model, USD. */
  rewriteCostUsd: number;
  /** Cumulative session cost, USD (computed from transcript usage). */
  sessionCostUsd: number;
  /**
   * Claude Code's own running total for this session, couriered by the statusline from
   * its stdin `cost.total_cost_usd`. A second, independently-derived figure for the same
   * session: a persistent gap against `sessionCostUsd` means one of the two is wrong,
   * which no amount of internal consistency would reveal. Null until a statusline render
   * reports it (VS Code sessions have no statusline, so it stays null there).
   */
  officialCostUsd: number | null;
  /** Epoch ms the official cost was couriered. */
  officialCostAt: number | null;
  turns: number;
  /** Cost of switching to each candidate model right now (cache re-write), USD. */
  modelSwitchCostUsd: Record<string, number>;
  /**
   * "Prefix tax": USD paid each turn just to re-read this session's context
   * (warm cache read, 0.1x input) on the current model. The ambient cost of
   * carrying history vs. starting a fresh chat.
   */
  prefixTaxUsd: number;
  /** Prefix tax per turn on each candidate model right now, USD (for switch-vs-fresh compare). */
  prefixTaxByModel: Record<string, number>;
  keepwarm: {
    armed: boolean;
    pings: number;
    netSavedUsd: number;
    nextPingAt: number | null;
    /** Why keep-warm is (not) available, for UI display. */
    reason: string;
  };
  guardian: {
    /** Latest usage-limit percentages, from Claude Code's official `rate_limits` field couriered by the statusline, if any. */
    fiveHourPct: number | null;
    sevenDayPct: number | null;
    fiveHourResetsAt: number | null;
    sevenDayResetsAt: number | null;
    /** Pending one-shot instruction for hooks to deliver ("wrapup" | "handoff" | null). */
    pendingAction: "wrapup" | "handoff" | null;
    updatedAt: number | null;
  };
  updatedAt: number;
}

export interface PriceSpec {
  /** USD per million tokens. */
  inputPerM: number;
  outputPerM: number;
  /** Validity window (ISO dates, inclusive start, exclusive end). */
  from?: string;
  until?: string;
  /**
   * Fast-mode rates, on the models that have a fast tier at all. Absent means asking for
   * fast rates falls back to standard, which is right two ways: most models have no fast
   * tier (Opus 4.6 silently runs standard and bills standard, Opus 4.7 errors), and
   * inventing a premium we can't source would overstate the bill.
   *
   * Cache columns are deliberately not stored: the published multipliers (1.25x / 2x / 0.1x)
   * apply on top of fast rates, so deriving them keeps one source of truth.
   */
  fast?: FastRates;
}

/** Premium input/output rates for fast mode, USD per million tokens. */
export interface FastRates {
  inputPerM: number;
  outputPerM: number;
}

/**
 * Per-request billing modifiers, straight off a transcript `usage` block. Both are
 * reported by the API (what actually served the request), not requested by the client,
 * so they are the right thing to bill against.
 */
export interface RateMods {
  /** `usage.speed`: "fast" bills the premium tier on models that have one. */
  speed?: string;
  /** `usage.inference_geo`: "us" bills 1.1x across every category. */
  geo?: string;
}
