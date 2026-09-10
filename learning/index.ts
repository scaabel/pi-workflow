/**
 * Learning layer — interruptible, stateful learning/coaching/review sessions.
 *
 * Turns planning-time concept gaps into tutor sessions that persist what the
 * human *understands* (mastery, misconceptions, concept graph) in
 * ~/.pi/learning/, mirrored to an Obsidian vault as the durable, human-owned
 * knowledge layer.
 */

import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  Concept,
  LearningSession,
  QueueItem,
} from "./state.js";
import {
  advance,
  createSession,
  PHASES,
} from "./session.js";
import {
  enqueue,
  getConcept,
  loadState,
  nextReviewAt,
  pickDueConcept,
  saveSession,
  saveState,
  slugifyTopic,
  upsertConcept,
} from "./store.js";
import {
  coachPrompt,
  reviewPrompt,
  tutorPrompt,
} from "./tutor.js";
import {
  appendToNote,
  createNote,
  notePathFor,
  resolveVaultPath,
  setupVault,
  updateNoteMeta,
  vaultStatus,
  defaultVaultPath,
} from "./obsidian.js";

type LearningMode = "learn" | "coach" | "review";

let session: LearningSession | undefined;
let mode: LearningMode | undefined;
let pendingCompletion: { mastery: number; summary?: string } | undefined;
const offeredArtifacts = new Set<string>();

/** Tools the tutor may invoke while a learning session is active. */
const TUTOR_TOOLS = ["read", "ask_user", "learning_record", "subagent"];
let toolsBeforeLearning: string[] | undefined;

function clampMastery(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
    isError: true,
  };
}

function toolOk(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
  };
}

function restrictTutorTools(pi: ExtensionAPI): void {
  toolsBeforeLearning = pi.getActiveTools();
  pi.setActiveTools(TUTOR_TOOLS);
}

function restoreTutorTools(pi: ExtensionAPI): void {
  if (toolsBeforeLearning) pi.setActiveTools(toolsBeforeLearning);
  toolsBeforeLearning = undefined;
}

/* ----------------------------------------------------------------
 * Plan-artifact contract (Phase 3)
 * ---------------------------------------------------------------- */

function getActivePlanArtifactPath(ctx: ExtensionContext): string | undefined {
  let found: string | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "workflow-state") continue;
    const data = entry.data as { activePlan?: { artifactPath?: string } } | undefined;
    if (data?.activePlan?.artifactPath) found = data.activePlan.artifactPath;
  }
  return found;
}

function extractLearningConcepts(artifactText: string): string[] {
  const names = new Set<string>();
  const re = /^\s*-?\s*concept:\s*["'`]?([^"'`\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(artifactText)) !== null) {
    const name = m[1].trim().replace(/["'`]+$/, "");
    if (name) names.add(name);
  }
  return [...names];
}

/* ----------------------------------------------------------------
 * Session lifecycle
 * ---------------------------------------------------------------- */

async function startSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  topic: string,
  newMode: LearningMode,
): Promise<Concept> {
  const state = loadState();
  const concept = upsertConcept(state, topic);
  concept.status = "learning";

  const s = createSession(concept.id);
  s.masteryBefore = concept.mastery;
  advance(s, "discover"); // initial phase; retrieve is the first tutor step

  session = s;
  mode = newMode;

  await saveState(state);
  await saveSession(s);

  restoreTutorTools(pi); // drop any dangling prior restriction
  restrictTutorTools(pi);

  return concept;
}

function kickoff(topic: string, newMode: LearningMode): string {
  if (newMode === "learn") {
    return `Begin the learning session for "${topic}". Follow the injected tutor protocol: ask me what I already know (retrieval) before explaining anything, and advance phases with the learning_record tool.`;
  }
  if (newMode === "coach") {
    return `Coach me on "${topic}". Follow the injected coach protocol: pose a realistic problem and do NOT teach.`;
  }
  return `Review "${topic}" with me. Follow the injected review protocol: scenario questions, no re-teaching.`;
}

async function finalizeCompletion(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!pendingCompletion || !session) return;
  const { mastery, summary } = pendingCompletion;
  pendingCompletion = undefined;

  const state = loadState();
  const concept = getConcept(state, session.topicId);

  // Obsidian mirror (best-effort; learning state persists even without a vault).
  const vault = resolveVaultPath(state.settings);
  if (vault && concept) {
    try {
      await createNote(vault, concept.name, {
        name: concept.name,
        status: concept.status,
        mastery,
        related: concept.related,
      });
      await updateNoteMeta(vault, concept.name, {
        status: concept.status,
        mastery,
      });
      await appendToNote(
        notePathFor(vault, concept.name),
        "Review History",
        `mastery ${mastery}/100`,
      );
      for (const m of session.misconceptionsFound) {
        await appendToNote(
          notePathFor(vault, concept.name),
          "Misconceptions",
          m,
        );
      }
      if (summary?.trim() && ctx.hasUI) {
        const save = await ctx.ui.confirm(
          "Save to Obsidian?",
          "Save your explanation to your Obsidian note (My Understanding)?",
        );
        if (save) {
          await appendToNote(
            notePathFor(vault, concept.name),
            "My Understanding",
            summary.trim(),
          );
        }
      } else if (summary?.trim()) {
        await appendToNote(
          notePathFor(vault, concept.name),
          "My Understanding",
          summary.trim(),
        );
      }
    } catch {
      // Obsidian is optional; never fail the session over a note write.
    }
  }

  session = undefined;
  mode = undefined;
  restoreTutorTools(pi);

  ctx.ui.notify(`Learning complete. Mastery: ${mastery}%.`, "info");
}

/* ----------------------------------------------------------------
 * Extension entry
 * ---------------------------------------------------------------- */

export default function learningExtension(pi: ExtensionAPI) {
  /* ---------------- prompt injection ---------------- */

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!session || !mode) return;

    const concept = getConcept(loadState(), session.topicId);
    const topic = concept?.name ?? session.topicId;

    const content =
      mode === "learn"
        ? tutorPrompt(topic, concept, session)
        : mode === "coach"
          ? coachPrompt(topic)
          : reviewPrompt(topic, concept);

    return {
      message: {
        customType: "learning-mode",
        content,
        display: false,
      },
    };
  });

  /* ---------------- learning_record tool ---------------- */

  pi.registerTool({
    name: "learning_record",
    label: "Learning Record",
    description: [
      "Persist the state of an active learning/coaching/review session.",
      "The tutor calls this at every phase transition and at completion.",
      "action 'phase' advances the state machine (rejects out-of-order phases);",
      "'answer' logs a Q&A; 'mastery' records current mastery;",
      "'misconception' records a misconception; 'complete' finalizes the session.",
    ].join(" "),
    promptSnippet: "Record learning session state (phase/answer/mastery/misconception/complete)",
    parameters: Type.Object({
      action: Type.String({
        description: "One of: phase, answer, mastery, misconception, complete",
      }),
      phase: Type.Optional(Type.String({ description: "Phase name (for action=phase)" })),
      question: Type.Optional(Type.String({ description: "Question asked (for action=answer)" })),
      answer: Type.Optional(Type.String({ description: "Learner's answer (for action=answer)" })),
      mastery: Type.Optional(Type.Number({ description: "Mastery 0-100" })),
      statement: Type.Optional(Type.String({ description: "Misconception statement" })),
      correctModel: Type.Optional(Type.String({ description: "Correct model for the misconception" })),
      summary: Type.Optional(Type.String({ description: "Learner's final explanation (for action=complete)" })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!session) {
        return toolError("No active learning session. Start one with /learn, /coach, or /review.");
      }

      const state = loadState();
      const concept = getConcept(state, session.topicId);
      const now = new Date().toISOString();

      switch (params.action) {
        case "phase": {
          if (!params.phase) return toolError("action 'phase' requires the 'phase' parameter.");
          const result = advance(session, params.phase as (typeof PHASES)[number]);
          if (!result.ok) {
            return toolError(
              `Phase transition rejected: ${result.reason}. Legal order: ${PHASES.join(" → ")}.`,
            );
          }
          await saveSession(session);
          return toolOk(`Phase recorded: ${params.phase}`);
        }

        case "answer": {
          session.answers.push({
            phase: params.phase ?? "",
            question: params.question ?? "",
            answer: params.answer ?? "",
          });
          await saveSession(session);
          return toolOk("Answer recorded.");
        }

        case "mastery": {
          if (params.mastery === undefined) return toolError("action 'mastery' requires the 'mastery' parameter.");
          if (concept) {
            concept.mastery = clampMastery(params.mastery);
            await saveState(state);
          }
          return toolOk(`Mastery recorded: ${clampMastery(params.mastery)}/100`);
        }

        case "misconception": {
          if (!params.statement) return toolError("action 'misconception' requires the 'statement' parameter.");
          if (concept) {
            concept.misconceptions.push({
              id: `ms_${Date.now()}`,
              statement: params.statement,
              correctModel: params.correctModel ?? "",
              status: "open",
              discoveredAt: now,
            });
            session.misconceptionsFound.push(params.statement);
            await saveState(state);
            await saveSession(session);
          }
          return toolOk("Misconception recorded.");
        }

        case "complete": {
          if (mode === "learn") {
            const last = session.phases[session.phases.length - 1]?.phase;
            if (last !== "schedule" && last !== "assess2") {
              return toolError(
                `Cannot complete yet — current phase: ${last ?? "discover"}. Advance: ${PHASES.join(" → ")} first.`,
              );
            }
            if (last === "assess2") advance(session, "schedule");
          }

          const mastery = clampMastery(params.mastery ?? concept?.mastery ?? 0);
          session.endedAt = now;
          session.masteryAfter = mastery;

          if (concept) {
            concept.mastery = mastery;
            concept.confidence = params.mastery !== undefined ? clampMastery(params.mastery) : concept.confidence;
            concept.status = mastery >= 80 ? "learned" : "reviewing";
            concept.lastReviewed = now;
            const reviewCount = state.reviews.filter((r) => r.topicId === concept.id).length;
            concept.nextReview = nextReviewAt(reviewCount);
          }

          state.reviews.push({
            topicId: session.topicId,
            reviewedAt: now,
            result: "completed",
            masteryAfter: mastery,
          });

          await saveState(state);
          await saveSession(session);

          pendingCompletion = { mastery, summary: params.summary };

          return toolOk(`Session complete. Final mastery: ${mastery}/100.`);
        }

        default:
          return toolError(
            `Unknown action "${params.action}". Use: phase, answer, mastery, misconception, complete.`,
          );
      }
    },
  });

  /* ---------------- learning_lookup tool (Phase 3) ---------------- */

  pi.registerTool({
    name: "learning_lookup",
    label: "Learning Lookup",
    description:
      "Look up a concept in the human learning model. Returns mastery, status, Obsidian note path, and known misconceptions.",
    promptSnippet: "Look up a concept's mastery/status/misconceptions",
    parameters: Type.Object({
      concept: Type.String({ description: "Concept name to look up" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const state = loadState();
      const concept = getConcept(state, slugifyTopic(params.concept));

      if (!concept) {
        return toolOk(JSON.stringify({ known: false, concept: params.concept }, null, 2));
      }

      const vault = resolveVaultPath(state.settings);
      return toolOk(
        JSON.stringify(
          {
            known: true,
            concept: concept.name,
            mastery: concept.mastery,
            status: concept.status,
            notePath: vault ? notePathFor(vault, concept.name) : undefined,
            misconceptions: concept.misconceptions.map((m) => m.statement),
          },
          null,
          2,
        ),
      );
    },
  });

  /* ---------------- settlement ---------------- */

  pi.on("agent_settled", async (_event, ctx) => {
    // A learning session just finished → persist + notify.
    if (pendingCompletion) {
      await finalizeCompletion(pi, ctx);
      return;
    }

    // No session active → surface plan-embedded concepts (Phase 3), non-blocking.
    if (session) return;

    const artifactPath = getActivePlanArtifactPath(ctx);
    if (!artifactPath || offeredArtifacts.has(artifactPath)) return;

    let text = "";
    try {
      text = await fs.promises.readFile(artifactPath, "utf-8");
    } catch {
      return;
    }

    const concepts = extractLearningConcepts(text);
    if (concepts.length === 0) return;

    offeredArtifacts.add(artifactPath);
    ctx.ui.notify(
      `Plan proposes ${concepts.length} learning concept(s): ${concepts.join(", ")}. Run /plan-learn to review them.`,
      "info",
    );
  });

  /* ---------------- /learn ---------------- */

  pi.registerCommand("learn", {
    description: "Start a learning session for a topic, or manage the queue/status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const topic = args.trim();

      if (!topic) {
        ctx.ui.notify(
          [
            "Usage:",
            "  /learn <topic>      — learn a concept",
            "  /learn queue        — list queued topics",
            "  /learn status       — concept mastery overview",
            "  /learn graph        — concept relationship graph",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (topic === "queue") {
        const state = loadState();
        if (state.queue.length === 0) {
          ctx.ui.notify("Queue is empty. /learn <topic> to add one.", "info");
          return;
        }
        const lines = state.queue.map(
          (q: QueueItem) => `[${q.priority}] ${q.topic} — ${q.reason} (from ${q.source})`,
        );
        ctx.ui.notify(`Learning queue:\n${lines.join("\n")}`, "info");
        return;
      }

      if (topic === "status") {
        const state = loadState();
        const concepts = Object.values(state.concepts);
        if (concepts.length === 0) {
          ctx.ui.notify("No concepts yet. /learn <topic> to start.", "info");
          return;
        }
        const lines = concepts
          .sort((a, b) => b.mastery - a.mastery)
          .map((c) => {
            const bar = "█".repeat(Math.round(c.mastery / 10)) + "░".repeat(10 - Math.round(c.mastery / 10));
            return `${c.name} [${c.status}] ${bar} ${c.mastery}%`;
          });
        ctx.ui.notify(`Concepts:\n${lines.join("\n")}`, "info");
        return;
      }

      if (topic === "graph") {
        const state = loadState();
        const concepts = Object.values(state.concepts);
        if (concepts.length === 0) {
          ctx.ui.notify("No concepts yet.", "info");
          return;
        }
        const lines = concepts.map((c) => {
          const related = c.related.length > 0 ? c.related.join(", ") : "(none)";
          return `${c.name} → ${related}`;
        });
        ctx.ui.notify(`Concept graph:\n${lines.join("\n")}`, "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Waiting for the current agent run to finish...", "info");
        await ctx.waitForIdle();
      }

      await startSession(pi, ctx, topic, "learn");
      pi.sendUserMessage(kickoff(topic, "learn"));
    },
  });

  /* ---------------- /coach ---------------- */

  pi.registerCommand("coach", {
    description: "Start a problem-first coaching session for a topic",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify("Usage: /coach <topic>", "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Waiting for the current agent run to finish...", "info");
        await ctx.waitForIdle();
      }

      await startSession(pi, ctx, topic, "coach");
      pi.sendUserMessage(kickoff(topic, "coach"));
    },
  });

  /* ---------------- /review ---------------- */

  pi.registerCommand("review", {
    description: "Review the most due (or weakest) concept",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Waiting for the current agent run to finish...", "info");
        await ctx.waitForIdle();
      }

      const state = loadState();
      const concept = pickDueConcept(state);
      if (!concept) {
        ctx.ui.notify("Nothing to review yet. /learn <topic> first.", "info");
        return;
      }

      await startSession(pi, ctx, concept.name, "review");
      pi.sendUserMessage(kickoff(concept.name, "review"));
    },
  });

  /* ---------------- /plan-learn (Phase 3) ---------------- */

  pi.registerCommand("plan-learn", {
    description: "Review the active plan's learning concepts and learn/skip/defer each",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const artifactPath = getActivePlanArtifactPath(ctx);
      if (!artifactPath) {
        ctx.ui.notify("No active plan found. Run /plan first.", "warning");
        return;
      }

      let text = "";
      try {
        text = await fs.promises.readFile(artifactPath, "utf-8");
      } catch (e) {
        ctx.ui.notify(`Could not read plan artifact: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }

      const concepts = extractLearningConcepts(text);
      if (concepts.length === 0) {
        ctx.ui.notify("No learning concepts found in the plan's learning: section.", "info");
        return;
      }

      const state = loadState();
      for (const name of concepts) {
        const concept = getConcept(state, slugifyTopic(name));
        const mastery = concept?.mastery ?? 0;
        if (mastery >= 80) continue; // already solid

        const choice = await ctx.ui.select(
          `Concept: ${name} (mastery ${mastery}/100)`,
          ["learn", "skip", "later"],
        );
        if (!choice || choice === "skip") continue;
        if (choice === "later") {
          enqueue(state, { topic: name, source: artifactPath, priority: "medium", reason: "deferred from plan" });
          await saveState(state);
          ctx.ui.notify(`Deferred "${name}" to the learning queue.`, "info");
          continue;
        }
        // learn → start a session and return; remaining concepts wait for /plan-learn again.
        if (!ctx.isIdle()) await ctx.waitForIdle();
        await startSession(pi, ctx, name, "learn");
        pi.sendUserMessage(kickoff(name, "learn"));
        ctx.ui.notify(`Learning "${name}". Re-run /plan-learn for remaining concepts.`, "info");
        return;
      }

      ctx.ui.notify("No low-mastery concepts left to learn.", "info");
    },
  });

  /* ---------------- /obsidian ---------------- */

  pi.registerCommand("obsidian", {
    description: "Set up or inspect the Obsidian knowledge vault",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0];

      if (sub === "setup") {
        const state = loadState();
        const vaultPath = state.settings.obsidianVaultPath ?? defaultVaultPath();
        await setupVault(vaultPath);
        state.settings.obsidianVaultPath = vaultPath;
        await saveState(state);

        ctx.ui.notify(
          [
            `Vault scaffolded at: ${vaultPath}`,
            "",
            "Remaining manual step (Obsidian has no headless vault registration):",
            "  Obsidian → Open folder as vault → select the path above",
            `  (or: open "obsidian://open?path=${encodeURIComponent(vaultPath)}")`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "status") {
        const state = loadState();
        const vault = resolveVaultPath(state.settings);
        const status = vaultStatus(vault);
        ctx.ui.notify(
          [
            "Obsidian status",
            `  vault path: ${status.path ?? "(none configured)"}`,
            `  exists: ${status.exists}`,
            `  concept notes: ${status.conceptNotes}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      ctx.ui.notify("Usage: /obsidian setup | /obsidian status", "info");
    },
  });
}
