/**
 * Knowledge extension — registers the `/knowledge` command surface and the
 * LLM-callable knowledge tools. The heavy lifting lives in `adapter.ts`; this
 * file is the thin pi-facing shell.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createKnowledgeAdapter, resolveKnowledgeDir, scaffoldRepo, type KnowledgeAdapter } from "./adapter.js";
import { renderReport } from "./validate.js";
import { isGitRepo, gitInit } from "./git.js";
import { decisionId, decisionPath, sanitizeSlug, today } from "./layout.js";

const USAGE = [
  "Usage:",
  "  /knowledge setup [path]  — scaffold the knowledge repo (git init if needed)",
  "  /knowledge status        — git status --short",
  "  /knowledge diff          — working-tree diff",
  "  /knowledge check         — validate the knowledge graph",
  "  /knowledge index         — regenerate _index/",
  "  /knowledge review        — review and accept/edit/reject changes",
  "  /knowledge commit <msg>  — check → index → diff → commit (no auto-push)",
  "  /knowledge push          — push (explicit only)",
  "  /knowledge search <q>    — full-text search",
  "  /knowledge path          — print the resolved knowledge dir",
].join("\n");

async function persistKnowledgeDir(settingsPath: string, dir: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    settings.knowledgeDir = dir;
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

function fmt(result: { ok: boolean; output: string }): string {
  return result.ok ? result.output || "ok" : `failed: ${result.output}`;
}

export default function knowledgeExtension(pi: ExtensionAPI): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");

  function adapter(): KnowledgeAdapter {
    return createKnowledgeAdapter(resolveKnowledgeDir({ settingsPath }));
  }

  /* ---------------- tools ---------------- */

  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Full-text search the knowledge repo (pi-knowledge). Returns matching files with line numbers and snippets.",
    promptSnippet: "Search the personal knowledge repo",
    parameters: Type.Object({
      query: Type.String({ description: "Text to search for (case-insensitive)" }),
    }),
    async execute(_id, params) {
      const hits = await adapter().search(params.query);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${params.query}".` }], details: {} };
      }
      const text = hits
        .map((h) => `${h.relPath}:${h.line}  ${h.snippet}`)
        .join("\n");
      return { content: [{ type: "text", text }], details: { hits } };
    },
  });

  pi.registerTool({
    name: "knowledge_read",
    label: "Knowledge Read",
    description:
      "Read an artifact from the knowledge repo by stable ID (e.g. concept.temporal-activity-retries). For global concepts, includes the features that demonstrate it.",
    promptSnippet: "Read a knowledge artifact by ID",
    parameters: Type.Object({
      id: Type.String({ description: "Stable artifact ID, e.g. concept.x, feature.project.foo, plan.2026-01-01.foo" }),
    }),
    async execute(_id, params) {
      const k = adapter();
      const art = await k.resolveId(params.id);
      if (!art) {
        return {
          content: [{ type: "text", text: `Unknown id: ${params.id}. Try /knowledge search.` }],
          details: {},
          isError: true,
        };
      }
      const body = await k.read(art.path);
      const used = await k.usedIn(params.id);
      const backlinks = used.filter((u) => u.relType === "uses" || u.relType === "produces");
      const text =
        body +
        (backlinks.length > 0
          ? `\n\n## Demonstrated By\n\n${backlinks.map((b) => `- ${b.title ?? b.id} (\`${b.id}\`)`).join("\n")}\n`
          : "");
      return { content: [{ type: "text", text }], details: { artifact: art } };
    },
  });

  pi.registerTool({
    name: "knowledge_propose_decision",
    label: "Propose Decision",
    description:
      "Draft an architectural decision (ADR) into the knowledge repo's decisions/ directory. Staged for human review — it is not committed automatically.",
    promptSnippet: "Propose an architectural decision",
    parameters: Type.Object({
      title: Type.String({ description: "Short decision title, e.g. 'Use Git as the knowledge store'" }),
      context: Type.String({ description: "Context: what situation led to this decision" }),
      problem: Type.String({ description: "Problem: what needed deciding" }),
      decision: Type.String({ description: "Decision: what was chosen and why" }),
      alternatives: Type.String({ description: "Alternatives: options considered and rejected" }),
      consequences: Type.String({ description: "Consequences: what follows from this decision" }),
      featureId: Type.Optional(Type.String({ description: "Optional feature ID to record a `records` backlink from" })),
    }),
    async execute(_id, params) {
      const k = adapter();
      const slug = sanitizeSlug(params.title);
      const rel = decisionPath(slug);
      const did = decisionId(slug);

      const content = [
        "---",
        `id: ${did}`,
        "type: decision",
        "---",
        "",
        `# ${params.title}`,
        "",
        "## Context",
        "",
        params.context.trim(),
        "",
        "## Problem",
        "",
        params.problem.trim(),
        "",
        "## Decision",
        "",
        params.decision.trim(),
        "",
        "## Alternatives",
        "",
        params.alternatives.trim(),
        "",
        "## Consequences",
        "",
        params.consequences.trim(),
        "",
        `## Date`,
        "",
        today(),
        "",
      ].join("\n");

      const abs = await k.create(rel, content);
      if (params.featureId) {
        await k.link(params.featureId, did, "records");
      }
      return {
        content: [
          {
            type: "text",
            text: `Staged decision ${did} at ${rel}.\nReview and commit with /knowledge review (or /knowledge commit "decision: ...").`,
          },
        ],
        details: { path: abs },
      };
    },
  });

  /* ---------------- /knowledge command ---------------- */

  async function review(ctx: ExtensionCommandContext): Promise<void> {
    const k = adapter();
    if (!(await k.isRepo())) {
      ctx.ui.notify("Not a git repository. Run /knowledge setup first.", "warning");
      return;
    }
    for (;;) {
      const status = await k.status();
      const diff = await k.diff();
      if (!status.trim() && !diff.trim()) {
        ctx.ui.notify("No uncommitted changes.", "info");
        return;
      }
      const choice = await ctx.ui.select("Knowledge review", [
        "Accept & commit",
        "Edit (re-diff)",
        "Reject changes",
        "Cancel",
      ]);
      if (!choice || choice === "Cancel") return;

      if (choice === "Accept & commit") {
        const msg = await ctx.ui.input("Commit message:", "learn: ...");
        if (!msg?.trim()) return;
        const r = await k.commit(msg.trim());
        ctx.ui.notify(r.ok ? `Committed: ${msg.trim()}` : fmt(r), r.ok ? "info" : "error");
        return;
      }
      if (choice === "Edit (re-diff)") {
        ctx.ui.notify("Edit the files in the knowledge repo, then continue.", "info");
        await ctx.ui.confirm("Done editing?", "Select OK to re-show the diff.");
        continue;
      }
      if (choice === "Reject changes") {
        const r = await k.restore();
        ctx.ui.notify(r.ok ? "Changes reverted." : fmt(r), r.ok ? "info" : "error");
        return;
      }
    }
  }

  async function commitFlow(ctx: ExtensionCommandContext, message: string): Promise<void> {
    if (!message.trim()) {
      ctx.ui.notify("Usage: /knowledge commit <message>", "info");
      return;
    }
    const k = adapter();
    const report = await k.check();
    const reportText = renderReport(report);
    if (!report.ok) {
      ctx.ui.notify(`Check failed — not committing.\n\n${reportText}`, "error");
      return;
    }
    await k.index();
    const status = await k.status();
    const diff = await k.diff();
    ctx.ui.notify([reportText, "", "Changes:", status || "(none)", diff].filter(Boolean).join("\n"), "info");
    const ok = await ctx.ui.confirm("Commit?", `Commit with message "${message}"?`);
    if (!ok) return;
    const r = await k.commit(message.trim());
    ctx.ui.notify(r.ok ? "Committed." : fmt(r), r.ok ? "info" : "error");
  }

  pi.registerCommand("knowledge", {
    description: "Manage the git-backed personal knowledge repo",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const k = adapter();

      if (!sub) {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      switch (sub) {
        case "setup": {
          const target = rest[0] ? path.resolve(rest[0]) : resolveKnowledgeDir({ settingsPath });
          const created = await scaffoldRepo(target);
          if (!(await isGitRepo(target))) await gitInit(target);
          const persisted = await persistKnowledgeDir(settingsPath, target);
          ctx.ui.notify(
            [
              `Knowledge repo scaffolded at: ${target}`,
              `  created: ${created.length} path(s)`,
              persisted
                ? `  persisted knowledgeDir to ${settingsPath}`
                : "  (could not persist knowledgeDir; set PI_KNOWLEDGE_DIR or edit settings.json)",
              "",
              "Next: add a remote manually (git remote add origin …) and /knowledge review to commit the scaffold.",
              "For a per-machine path, prefer export PI_KNOWLEDGE_DIR=… over settings.json.",
            ].join("\n"),
            "info",
          );
          return;
        }

        case "status": {
          ctx.ui.notify((await k.status()) || "clean", "info");
          return;
        }

        case "diff": {
          ctx.ui.notify((await k.diff()) || "no changes", "info");
          return;
        }

        case "check": {
          ctx.ui.notify(renderReport(await k.check()), "info");
          return;
        }

        case "index": {
          const written = await k.index();
          ctx.ui.notify(`Generated ${written.length} index file(s) under _index/.`, "info");
          return;
        }

        case "review": {
          await review(ctx);
          return;
        }

        case "commit": {
          await commitFlow(ctx, rest.join(" "));
          return;
        }

        case "push": {
          const r = await k.push();
          ctx.ui.notify(r.ok ? "Pushed." : fmt(r), r.ok ? "info" : "error");
          return;
        }

        case "search": {
          const q = rest.join(" ").trim();
          if (!q) {
            ctx.ui.notify("Usage: /knowledge search <query>", "info");
            return;
          }
          const hits = await k.search(q);
          ctx.ui.notify(hits.length ? hits.map((h) => `${h.relPath}:${h.line}  ${h.snippet}`).join("\n") : `No matches for "${q}".`, "info");
          return;
        }

        case "path": {
          ctx.ui.notify(k.dir, "info");
          return;
        }

        default: {
          ctx.ui.notify(USAGE, "info");
          return;
        }
      }
    },
  });
}
