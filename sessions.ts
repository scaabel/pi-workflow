/**
 * /sessions and /sessions-stats — cross-project session dashboard.
 *
 * /sessions: list every session (name, project, age, messages) and resume
 * the selected one in-place via ctx.switchSession().
 * /sessions-stats: aggregate sessions per project with totals.
 *
 * // ponytail: no token/cost per session — SessionInfo doesn't expose usage.
 * // Add later by scanning each session JSONL for assistant message usage
 * // if cost tracking matters.
 */
import * as os from "node:os";
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function relTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function shortCwd(cwd: string): string {
  return cwd ? cwd.replace(os.homedir(), "~").split("/").pop() || cwd : "(unknown)";
}

function labelFor(session: SessionInfo, index: number): string {
  const title = session.name || session.firstMessage.slice(0, 60) || "(no messages)";
  return `#${index}  ${title}  ·  ${shortCwd(session.cwd)}  ·  ${relTime(session.modified)}  ·  ${session.messageCount} msgs`;
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "Browse and resume sessions across all projects",
    handler: async (_args, ctx) => {
      const all = (await SessionManager.listAll()).sort(
        (a, b) => b.modified.getTime() - a.modified.getTime(),
      );
      const current = ctx.sessionManager.getSessionFile();
      const sessions = all.filter((s) => s.path !== current);

      if (sessions.length === 0) {
        ctx.ui.notify("No other sessions found.", "info");
        return;
      }
      if (!ctx.hasUI) return;

      const labels = sessions.map((s, i) => labelFor(s, i));
      const choice = await ctx.ui.select(
        `Sessions (${sessions.length}, most recent first)`,
        labels,
      );
      if (!choice) return;

      const index = parseInt(/^#(\d+)/.exec(choice)?.[1] ?? "-1", 10);
      const picked = sessions[index];
      if (!picked) return;

      const title = picked.name || picked.firstMessage.slice(0, 60);
      await ctx.switchSession(picked.path, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Resumed: ${title}`, "info");
        },
      });
    },
  });

  pi.registerCommand("sessions-stats", {
    description: "Show session counts and message totals per project",
    handler: async (_args, ctx) => {
      const all = await SessionManager.listAll();
      if (all.length === 0) {
        ctx.ui.notify("No sessions found.", "info");
        return;
      }

      const byProject = new Map<string, { count: number; messages: number; last: Date }>();
      for (const s of all) {
        const key = shortCwd(s.cwd);
        const entry = byProject.get(key) ?? { count: 0, messages: 0, last: s.modified };
        entry.count++;
        entry.messages += s.messageCount;
        if (s.modified > entry.last) entry.last = s.modified;
        byProject.set(key, entry);
      }

      const lines = [
        `Sessions: ${all.length} total, ${byProject.size} projects`,
        "",
        ...[...byProject.entries()]
          .sort((a, b) => b[1].last.getTime() - a[1].last.getTime())
          .map(
            ([project, e]) =>
              `${project}: ${e.count} session${e.count > 1 ? "s" : ""}, ${e.messages} messages, last ${relTime(e.last)}`,
          ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
