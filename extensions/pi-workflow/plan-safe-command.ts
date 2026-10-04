/**
 * Read-only bash gate for plan mode.
 *
 * Dependency-free so it can be unit-tested standalone (see
 * `plan-safe-command.selfcheck.ts`); `plan-mode.ts` imports it.
 *
 * Deliberately conservative: only a small allowlist of read-only commands is
 * permitted, with two read-only exceptions for grep BRE alternation (`\|`) and
 * `/dev/null` redirects. Everything that can chain, redirect, or substitute is
 * rejected.
 */

const SAFE_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "find",
  "fd",
  "ls",
  "pwd",
  "tree",
]);

function getCommand(command: string): string {
  const trimmed = command.trim();

  const first = trimmed
    .split(/\s+/)[0]
    ?.replace(/^command\s+/, "");

  return first ?? "";
}

/**
 * True only for commands that can read but not write.
 *
 * `\|` is grep BRE alternation (not a shell pipe) and `/dev/null` redirects
 * discard output without touching a real file; both are stripped before the
 * dangerous-metacharacter check.
 */
export function isSafeCommand(command: string): boolean {
  const sanitized = command
    .replace(/\\\|/g, " ")
    .replace(/[12&]*>>?\s*\/dev\/null/g, " ");

  if (
    sanitized.includes(">") ||
    sanitized.includes(">>") ||
    sanitized.includes("|") ||
    sanitized.includes("&&") ||
    sanitized.includes("||") ||
    sanitized.includes(";") ||
    sanitized.includes("$(") ||
    sanitized.includes("`")
  ) {
    return false;
  }

  return SAFE_COMMANDS.has(getCommand(command));
}
