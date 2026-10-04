/**
 * Dependency-free self-check for the plan-mode read-only bash gate.
 * Run with: bun extensions/pi-workflow/plan-safe-command.selfcheck.ts
 */
import { isSafeCommand } from "./plan-safe-command";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

function main() {
  // Read-only commands are allowed.
  assert(isSafeCommand("ls -la"), "allow: ls");
  assert(isSafeCommand("cat README.md"), "allow: cat");
  assert(isSafeCommand('find . -name "*.ts"'), "allow: find");
  assert(isSafeCommand("pwd"), "allow: pwd");
  assert(isSafeCommand('grep -rn "a\\|b" src'), "allow: grep BRE alternation");
  assert(
    isSafeCommand('grep -rn "a\\|b" src 2>/dev/null'),
    "allow: grep alternation + stderr discard",
  );
  assert(isSafeCommand("head -5 x.txt 2>/dev/null"), "allow: head + stderr discard");
  assert(isSafeCommand("cat x.txt >/dev/null"), "allow: stdout discard");
  assert(isSafeCommand("cat x.txt >> /dev/null"), "allow: append discard with space");

  // Real writes, pipes, chaining, and substitutions are blocked.
  assert(!isSafeCommand("echo hi > x"), "block: file redirect");
  assert(!isSafeCommand("echo hi >> x"), "block: append redirect");
  assert(!isSafeCommand("ls | grep a"), "block: pipe");
  assert(!isSafeCommand("rm -rf /"), "block: not an allowlisted command");
  assert(!isSafeCommand("cat a && rm b"), "block: chaining");
  assert(!isSafeCommand("cat a || rm b"), "block: or-chaining");
  assert(!isSafeCommand("cat a; rm b"), "block: semicolon");
  assert(!isSafeCommand("cat $(pwd)"), "block: command substitution");
  assert(!isSafeCommand("cat `pwd`"), "block: backtick substitution");
  assert(!isSafeCommand('grep -E "a|b" x'), "block: unescaped pipe in quotes");

  console.log("plan-safe-command selfcheck: all passed");
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
