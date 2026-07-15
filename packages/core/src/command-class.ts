/**
 * Normalize a Bash command into a comparable "command class" and detect rtk wrapping.
 * Used for per-command token attribution and the rtk A/B verdict (M4).
 */
export interface CommandClass {
  cls: string;
  rtkWrapped: boolean;
}

const TWO_WORD_HEADS = new Set(["git", "npm", "pnpm", "yarn", "cargo", "docker", "kubectl", "go", "dotnet", "pip", "uv", "gh", "rtk"]);

export function classifyCommand(command: string): CommandClass {
  let c = command.trim();
  // Strip leading env assignments (FOO=bar cmd ...)
  c = c.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  // First pipeline stage / command in a chain determines the class.
  const first = c.split(/\s*(?:\||&&|;)\s*/, 1)[0] ?? c;
  const tokens = first.split(/\s+/).filter(Boolean);
  let rtkWrapped = false;
  if (tokens[0] === "rtk") {
    rtkWrapped = true;
    tokens.shift();
  }
  const head = tokens[0] ?? "(empty)";
  let cls = head;
  if (TWO_WORD_HEADS.has(head) && tokens[1] && /^[a-z-]+$/.test(tokens[1])) {
    cls = `${head} ${tokens[1]}`;
  }
  return { cls, rtkWrapped };
}
