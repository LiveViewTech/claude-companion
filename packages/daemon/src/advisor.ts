import type { CccConfig } from "./config.ts";
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

/**
 * Instruction bodies, parameterized by WHY the guardian armed. The cause is supplied per
 * session (`guardian.pendingReason`) rather than hardcoded: the same action arms for a usage
 * window, a context-size threshold, or keep-warm giving up, and stating the wrong cause tells
 * Claude something false about the user's account.
 */
const GUARDIAN_CONTEXT = {
  wrapup: (cause: string, _handoffPath: string) =>
    `claude-companion guardian: ${cause}. ` +
    "Before or alongside this request, capture current context — update the project's existing docs/CLAUDE.md in place with " +
    "the state of the work and decisions made — and steer toward wrapping up cleanly rather than opening new work.",
  handoff: (cause: string, handoffPath: string) =>
    `claude-companion guardian: ${cause}. ` +
    `Update ${handoffPath} if it already exists — revise it in place, preserving anything still accurate, ` +
    "rather than replacing it wholesale — or create it if it does not. It should carry the goal, current state, done vs " +
    "remaining, key files, decisions, and precise next steps, so a fresh session can resume cheaply from it alone. " +
    "Then steer toward wrapping up cleanly.",
} as const;

/** Named when the daemon couldn't resolve one (no cwd reported yet for the session). */
const HANDOFF_FALLBACK = "HANDOFF.md";

/**
 * In-memory prompt advisor. Pure heuristics — no model calls; must answer in
 * single-digit milliseconds because a hook blocks on it.
 * Throttle: at most one plan nudge per cfg.advisor.nudgeEvery prompts per session.
 */
export class Advisor {
  private tracker: SessionTracker;
  private cfg: CccConfig;
  private promptCounts = new Map<string, number>();
  private lastNudgeAt = new Map<string, number>();
  private ackGuardian: (sessionId: string, action: string) => boolean;

  constructor(opts: {
    tracker: SessionTracker;
    cfg: CccConfig;
    ackGuardian: (sessionId: string, action: string) => boolean;
  }) {
    this.tracker = opts.tracker;
    this.cfg = opts.cfg;
    this.ackGuardian = opts.ackGuardian;
  }

  advise(req: AdviseRequest): AdviseResponse {
    const res: AdviseResponse = {};
    const state = this.tracker.get(req.session_id);
    const n = (this.promptCounts.get(req.session_id) ?? 0) + 1;
    this.promptCounts.set(req.session_id, n);

    // 1) Guardian delivery rides along with the next prompt (whichever surface
    //    fires first acks; the other then sees pending == null). This is part of the
    //    usage-limit guardian (governed by guardian.action), NOT the advisor toggle —
    //    it must keep working even when the plan nudge is switched off.
    const pending = state?.guardian.pendingAction;
    // Capture the reason AND the resolved path before acking — ack clears both along with
    // pendingAction.
    const cause = state?.guardian.pendingReason ?? "this session should capture its state now";
    const handoffPath = state?.guardian.pendingHandoffPath ?? HANDOFF_FALLBACK;
    if (pending && this.ackGuardian(req.session_id, pending)) {
      res.additionalContext = GUARDIAN_CONTEXT[pending](cause, handoffPath);
      res.systemMessage = `⚠ ccc guardian: ${cause} — asked Claude to ${pending === "handoff" ? `update ${handoffPath} and wrap up` : "capture context and wrap up"}.`;
      return res; // guardian outranks nudges; never stack messages
    }

    // 2) Plan-first nudge for planning-shaped prompts early in a session. Master-switchable.
    if (!this.cfg.advisor.enabled) return res;
    const last = this.lastNudgeAt.get(req.session_id) ?? -Infinity;
    const throttled = n - last < this.cfg.advisor.nudgeEvery;
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
