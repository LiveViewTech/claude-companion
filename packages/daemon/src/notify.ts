import { createRequire } from "node:module";

/**
 * Cross-platform desktop notifications (Linux notify-send, Windows SnoreToast,
 * macOS Notification Center) via node-notifier, with stdout fallback.
 */
const require = createRequire(import.meta.url);

let notifier: { notify: (opts: Record<string, unknown>) => void } | null = null;
try {
  notifier = require("node-notifier") as { notify: (opts: Record<string, unknown>) => void };
} catch {
  notifier = null;
}

export interface ToastOptions {
  title: string;
  message: string;
}

export function toast(opts: ToastOptions, enabled = true): void {
  const line = `[toast] ${opts.title}: ${opts.message}`;
  if (!enabled) return;
  if (notifier) {
    try {
      notifier.notify({ title: opts.title, message: opts.message, appID: "claude-companion" });
      return;
    } catch {
      /* fall through */
    }
  }
  console.log(line);
}
