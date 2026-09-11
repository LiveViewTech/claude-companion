/**
 * Normalize a Bash command into a comparable "command class".
 * Used for per-command token attribution (M4).
 */
const TWO_WORD_HEADS = new Set(["git", "npm", "pnpm", "yarn", "cargo", "docker", "kubectl", "go", "dotnet", "pip", "uv", "gh"]);

export function classifyCommand(command: string): string {
  let c = command.trim();
  // Strip leading env assignments (FOO=bar cmd ...)
  c = c.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  // First pipeline stage / command in a chain determines the class.
  const first = c.split(/\s*(?:\||&&|;)\s*/, 1)[0] ?? c;
  const tokens = first.split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? "(empty)";
  if (TWO_WORD_HEADS.has(head) && tokens[1] && /^[a-z-]+$/.test(tokens[1])) {
    return `${head} ${tokens[1]}`;
  }
  return head;
}
