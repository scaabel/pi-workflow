/**
 * Git backend for the knowledge repo. `node:child_process.execFile` only —
 * decoupled from pi so the rest of the adapter stays testable.
 */

import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let code = 0;
      if (error) {
        const e = error as { code?: unknown };
        code = typeof e.code === "number" ? e.code : 1;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

async function runGit(dir: string, args: string[], exec: ExecFn = defaultExec): Promise<ExecResult> {
  return exec("git", args, dir);
}

export async function isGitRepo(dir: string, exec: ExecFn = defaultExec): Promise<boolean> {
  const r = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], exec);
  return r.code === 0;
}

export async function gitInit(dir: string, exec: ExecFn = defaultExec): Promise<ExecResult> {
  return runGit(dir, ["init"], exec);
}

export async function gitStatus(dir: string, exec: ExecFn = defaultExec): Promise<string> {
  const r = await runGit(dir, ["status", "--short"], exec);
  if (r.code !== 0) return `git status failed: ${r.stderr || r.stdout}`;
  return r.stdout;
}

/** Working-tree review: short status + tracked diff (untracked shown in status). */
export async function gitDiff(dir: string, exec: ExecFn = defaultExec): Promise<string> {
  const stat = await runGit(dir, ["diff", "--stat"], exec);
  const full = await runGit(dir, ["diff"], exec);
  const parts: string[] = [];
  if (stat.stdout.trim()) parts.push(stat.stdout.trim());
  if (full.stdout.trim()) parts.push(full.stdout.trim());
  return parts.join("\n\n") || "";
}

export async function gitCommit(dir: string, message: string, exec: ExecFn = defaultExec): Promise<ExecResult> {
  const add = await runGit(dir, ["add", "-A"], exec);
  if (add.code !== 0) return add;
  const r = await runGit(dir, ["commit", "-m", message], exec);
  return r;
}

export async function gitPush(dir: string, exec: ExecFn = defaultExec): Promise<ExecResult> {
  return runGit(dir, ["push"], exec);
}

export async function gitMove(
  dir: string,
  from: string,
  to: string,
  exec: ExecFn = defaultExec,
): Promise<ExecResult> {
  return runGit(dir, ["mv", from, to], exec);
}

/** Restore working tree: drop tracked changes and remove untracked files. */
export async function gitRestore(dir: string, exec: ExecFn = defaultExec): Promise<ExecResult> {
  const checkout = await runGit(dir, ["checkout", "--", "."], exec);
  if (checkout.code !== 0) return checkout;
  return runGit(dir, ["clean", "-fd"], exec);
}
