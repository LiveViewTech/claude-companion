import type { SessionTracker } from "./session-tracker.ts";

export interface AdviseRequest {
  session_id: string;
  prompt: string;
  cwd?: string;
}

export interface AdviseResponse {
  additionalContext?: string;
  systemMessage?: string;
}

const PLANNING_RE =
  /\b(plan|design|architect|architecture|refactor(?:ing)? (?:across|the)|rewrite|migrate|migration|from scratch|new (?:app|service|feature|system)|how should (?:we|i)|strategy|roadmap|rfc|proposal)\b/i;

const GUARDIAN_CONTEXT = {
  wrapup:
    "claude-companion rate-limit guardian: the user's subscription usage limit is nearly exhausted. " +
    "Before or alongside this request, capture current context — update project docs/CLAUDE.md with the state of the work " +
    "and decisions made — and steer toward wrapping up cleanly rather than opening new work.",
  handoff:
    "claude-companion rate-limit guardian: the user's subscription usage limit is nearly exhausted. " +
    "Write a HANDOFF.md (goal, current state, done vs remaining, key files, decisions, precise next steps) " +
    "so a fresh session after the limit resets can resume cheaply, then steer toward wrapping up cleanly.",
} as const;

/**
 * In-memory prompt advisor. Pure heuristics — no model calls; must answer in
 * single-digit milliseconds because a hook blocks on it.
 * Throttle: at most one nudge per NUDGE_EVERY prompts per session.
 */
export class Advisor {
  private tracker: SessionTracker;
  private promptCounts = new Map<string, number>();
  private lastNudgeAt = new Map<string, number>();
  private ackGuardian: (sessionId: string, action: string) => boolean;
  static NUDGE_EVERY = 10;

  constructor(tracker: SessionTracker, ackGuardian: (sessionId: string, action: string) => boolean) {
    this.tracker = tracker;
    this.ackGuardian = ackGuardian;
  }

  advise(req: AdviseRequest): AdviseResponse {
    const res: AdviseResponse = {};
    const state = this.tracker.get(req.session_id);
    const n = (this.promptCounts.get(req.session_id) ?? 0) + 1;
    this.promptCounts.set(req.session_id, n);

    // 1) Guardian delivery rides along with the next prompt (whichever surface
    //    fires first acks; the other then sees pending == null).
    const pending = state?.guardian.pendingAction;
    if (pending && this.ackGuardian(req.session_id, pending)) {
      res.additionalContext = GUARDIAN_CONTEXT[pending];
      const pct = state?.guardian.fiveHourPct ?? state?.guardian.sevenDayPct;
      res.systemMessage = `⚠ rate-limit guardian: ~${pct != null ? Math.round(pct) : "?"}% of subscription limit used — asked Claude to ${pending === "handoff" ? "write HANDOFF.md and wrap up" : "capture context and wrap up"}.`;
      return res; // guardian outranks nudges; never stack messages
    }

    // 2) Plan-first nudge for planning-shaped prompts early in a session.
    const last = this.lastNudgeAt.get(req.session_id) ?? -Infinity;
    const throttled = n - last < Advisor.NUDGE_EVERY;
    const planShaped = PLANNING_RE.test(req.prompt) || req.prompt.length > 600;
    const earlySession = (state?.turns ?? 0) < 8;
    if (planShaped && earlySession && !throttled) {
      this.lastNudgeAt.set(req.session_id, n);
      res.systemMessage =
        "💡 this looks like design/planning work — consider plan mode (shift+tab) so the approach is agreed before tokens go to implementation." +
        (state?.model && !/fable|opus/i.test(state.model)
          ? " A stronger model for the planning phase often pays for itself."
          : "");
    }

    return res;
  }
}
