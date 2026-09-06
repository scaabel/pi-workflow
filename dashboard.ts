/**
 * Session dashboard.
 *
 * - /dashboard (alias: /sessions): browse every session across
 *   projects, grouped by project, with a live search box.
 * - /dashboard-resume <path>: internal bridge used by the startup
 *   flow (event handlers can't switch sessions; commands can).
 * - /sessions-stats: per-project aggregates.
 * - Shown automatically on `pi` startup (reason "startup").
 *
 * // ponytail: visible list capped at MAX_VISIBLE rows with internal
 * // scrolling; the overlay's maxHeight clips on very short terminals.
 */
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE = 20;

interface ViewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function relTime(date: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );
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
  if (!cwd) return "(unknown)";
  const home = os.homedir();
  const shortened = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return shortened.split("/").filter(Boolean).pop() || shortened;
}

function sessionLabel(session: SessionInfo): string {
  return (
    session.name ||
    session.firstMessage.replace(/\s+/g, " ").trim().slice(0, 48) ||
    "(no messages)"
  );
}

/**
 * Build the flat ordered row model.
 *
 * With an empty query: group headers then their sessions.
 * With a query: flat filtered sessions (matches name, cwd, firstMessage).
 */
interface Row {
  kind: "header" | "session" | "create";
  label: string;
  time?: string;
  session?: SessionInfo;
}

function buildRows(
  sessions: SessionInfo[],
  query: string,
): Row[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    const byProject = new Map<string, SessionInfo[]>();

    for (const session of sessions) {
      const project = shortCwd(session.cwd).toUpperCase();
      const list = byProject.get(project) ?? [];
      list.push(session);
      byProject.set(project, list);
    }

    const rows: Row[] = [];

    for (const [project, list] of [...byProject.entries()].sort(
      (a, b) =>
        b[1][0]!.modified.getTime() -
        a[1][0]!.modified.getTime(),
    )) {
      rows.push({ kind: "header", label: project });

      for (const session of list.slice().reverse()) {
        rows.push({
          kind: "session",
          label: sessionLabel(session),
          time: relTime(session.modified),
          session,
        });
      }
    }

    return [{ kind: "create" as const, label: "+ New Session" }, ...rows];
  }

  const matches = sessions.filter((session) => {
    const haystack = [
      sessionLabel(session),
      session.cwd,
      session.name ?? "",
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(needle);
  });

  return [
    { kind: "create" as const, label: "+ New Session" },
    ...matches.map((session) => ({
      kind: "session" as const,
      label: sessionLabel(session),
      time: relTime(session.modified),
      session,
    })),
  ];
}

class SessionDashboard {
  public onSelect?: (path: string) => void;
  public onCancel?: () => void;
  public onCreate?: () => void;

  private readonly theme: ViewTheme;

  private readonly sessions: SessionInfo[];

  private query = "";

  private selected = 0;

  private scrollTop = 0;

  private cachedWidth?: number;

  private cachedRows?: Row[];

  constructor(
    theme: ViewTheme,
    sessions: SessionInfo[],
  ) {
    this.theme = theme;
    this.sessions = sessions;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }

  private rows(): Row[] {
    if (this.cachedRows === undefined) {
      this.cachedRows = buildRows(this.sessions, this.query);
    }
    return this.cachedRows;
  }

  private selectableIndices(): number[] {
    const out: number[] = [];

    this.rows().forEach((row, i) => {
      if (row.kind === "session" || row.kind === "create") out.push(i);
    });

    return out;
  }

  private clampSelection(): void {
    const indices = this.selectableIndices();
    if (indices.length === 0) {
      this.selected = 0;
      this.scrollTop = 0;
      return;
    }
    if (this.selected >= indices.length) this.selected = indices.length - 1;
    if (this.selected < 0) this.selected = 0;

    const rowIndex = indices[this.selected]!;

    if (rowIndex < this.scrollTop) this.scrollTop = rowIndex;
    if (rowIndex >= this.scrollTop + MAX_VISIBLE) {
      this.scrollTop = rowIndex - MAX_VISIBLE + 1;
    }
  }

  private resetSelection(): void {
    this.selected = 0;
    this.scrollTop = 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const indices = this.selectableIndices();
      const row = this.rows()[indices[this.selected]];
      if (row?.kind === "create") {
        this.onCreate?.();
      } else if (row?.session) {
        this.onSelect?.(row.session.path);
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("n"))) {
      this.onCreate?.();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selected--;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selected++;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.selected -= MAX_VISIBLE;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.selected += MAX_VISIBLE;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.selected = Number.MAX_SAFE_INTEGER;
      this.clampSelection();
      return;
    }

    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.query = this.query.slice(0, -1);
      this.cachedRows = undefined;
      this.resetSelection();
      return;
    }

    // Printable characters: type into the filter.
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.cachedRows = undefined;
      this.resetSelection();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      this.cachedWidth = width;
      this.cachedRows = undefined;
    }

    this.clampSelection();

    const rows = this.rows();
    const indices = this.selectableIndices();
    const selectedRowIndex = indices[this.selected];

    const lines: string[] = [];

    // Search box.
    const placeholder = "Search sessions...";
    const boxText =
      this.query.length === 0
        ? this.theme.fg("dim", placeholder)
        : this.theme.fg("text", this.query);
    lines.push(
      "  " +
        truncateToWidth(
          this.theme.fg("border", "▏") + " " + boxText,
          width,
        ),
    );

    lines.push(...[""]);

    // Body: windowed rows.
    const end = Math.min(this.scrollTop + MAX_VISIBLE, rows.length);

    for (let i = this.scrollTop; i < end; i++) {
      const row = rows[i]!;

      if (row.kind === "header") {
        lines.push(
          "  " +
            truncateToWidth(
              this.theme.fg("accent", this.theme.bold(row.label)),
              width,
            ),
        );
        continue;
      }

      if (row.kind === "create") {
        const isSelected = i === selectedRowIndex;
        const prefix = isSelected ? "› " : "  ";
        const label = prefix + row.label;
        const line =
          "  " +
          truncateToWidth(
            this.theme.fg(isSelected ? "accent" : "dim", label),
            width,
          );
        lines.push(isSelected ? this.theme.fg("accent", line) : line);
        continue;
      }

      const isSelected = i === selectedRowIndex;
      const prefix = isSelected ? "› " : "  ";
      const color = isSelected ? "accent" : "text";
      const label = prefix + row.label;
      const time = row.time ?? "";

      const labelWidth = Math.max(10, width - 4 - visibleWidth(time) - 2);
      const line =
        "  " +
        truncateToWidth(this.theme.fg(color, label), labelWidth) +
        "  " +
        truncateToWidth(this.theme.fg("dim", time), 24);

      lines.push(isSelected ? this.theme.fg("accent", line) : line);
    }

    if (rows.length === 0) {
      lines.push("  " + this.theme.fg("muted", `No sessions match "${this.query}".`));
    }

    // Footer.
    lines.push("");
    lines.push(
      this.theme.fg(
        "dim",
        `↑↓ navigate · type to search · enter resume · ctrl+n new session · esc cancel`,
      ),
    );

    return lines;
  }
}

type DashboardResult =
  | { path: string }
  | { create: true };

async function showDashboard(
  ctx: ExtensionContext,
): Promise<DashboardResult | undefined> {
  if (!ctx.hasUI) return undefined;

  const sessions = (await SessionManager.listAll()).sort(
    (a, b) => b.modified.getTime() - a.modified.getTime(),
  );

  const current = ctx.sessionManager.getSessionFile();
  const others = sessions.filter((s) => s.path !== current);

  if (others.length === 0) return undefined;

  const result = await ctx.ui.custom<DashboardResult | undefined>(
    (tui, theme, _keybindings, done) => {
      const view = new SessionDashboard(theme, others);

      view.onSelect = (path) => done({ path });
      view.onCancel = () => done(undefined);
      view.onCreate = () => done({ create: true });

      return {
        render: (w: number) => view.render(w),
        invalidate: () => view.invalidate(),
        handleInput: (data: string) => {
          view.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "90%",
      },
    },
  );

  return result;
}

export default function dashboardExtension(pi: ExtensionAPI) {
  /**
   * Start the dashboard UI and, if the user picked a session,
   * switch to it. Runs in command context, so switching is safe.
   */
  async function runDashboard(
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const result = await showDashboard(ctx);

    if (!result) return;

    if ("create" in result) {
      await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.sendUserMessage("Start a new session.");
        },
      });
      return;
    }

    await ctx.switchSession(result.path);
  }

  pi.registerCommand("dashboard", {
    description: "Browse and resume sessions across projects",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runDashboard(ctx);
    },
  });

  pi.registerCommand("sessions", {
    description: "Browse and resume sessions across projects",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runDashboard(ctx);
    },
  });

  /**
   * Internal bridge: event handlers can't switch sessions,
   * so the startup flow dispatches this command instead.
   */
  pi.registerCommand("dashboard-resume", {
    description: "Resume a session by path (internal)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const path = args.trim();

      if (!path) {
        ctx.ui.notify("dashboard-resume: missing session path.", "warning");
        return;
      }

      const result = await ctx.switchSession(path);

      if (!result.cancelled) {
        ctx.ui.notify("Resumed session.", "info");
      }
    },
  });

  pi.registerCommand("sessions-stats", {
    description: "Show session counts and message totals per project",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const all = await SessionManager.listAll();

      if (all.length === 0) {
        ctx.ui.notify("No sessions found.", "info");
        return;
      }

      const byProject = new Map<
        string,
        { count: number; messages: number; last: Date }
      >();

      for (const session of all) {
        const key = shortCwd(session.cwd);
        const entry =
          byProject.get(key) ?? { count: 0, messages: 0, last: session.modified };
        entry.count++;
        entry.messages += session.messageCount;
        if (session.modified > entry.last) entry.last = session.modified;
        byProject.set(key, entry);
      }

      const lines = [
        `Sessions: ${all.length} total, ${byProject.size} projects`,
        "",
        ...[...byProject.entries()]
          .sort((a, b) => b[1].last.getTime() - a[1].last.getTime())
          .map(
            ([project, entry]) =>
              `${project}: ${entry.count} session${entry.count > 1 ? "s" : ""}, ${entry.messages} messages, last ${relTime(entry.last)}`,
          ),
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /**
   * Show the dashboard on startup (plain `pi`), skip for
   * resume/reload/new/fork and when no sessions exist.
   */
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;

    const result = await showDashboard(ctx);

    if (result && "path" in result) {
      pi.sendUserMessage(`/dashboard-resume ${result.path}`, {
        expandPromptTemplates: true,
      });
    }
  });
}