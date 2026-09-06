import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  getArtifactRoot,
  isInsideArtifactRoot,
  readPlanArtifact,
  extractPlanText,
} from "./artifacts.js";

import { activateRole } from "./models.js";

import {
  extractPlanTitle,
  showPlanView,
} from "./plan-view.js";

import type {
  WorkflowState,
} from "./state.js";

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

const APPROVE_FRESH = "Approve & execute fresh";
const APPROVE_KEEP = "Approve & keep context";
const APPROVE_COMPACT = "Approve & compact context";
const REFINE = "Refine plan";
const CANCEL = "Cancel";

let pendingProposal: { slug: string } | undefined = undefined;
let pendingApprovedInjection: { artifactPath: string } | undefined = undefined;
let previousModel: { provider: string; modelId: string } | undefined = undefined;

export interface PlanModeController {
  enable(ctx: ExtensionContext): void;
  disable(ctx: ExtensionContext): void;
  isEnabled(): boolean;
}

/* ----------------------------------------------------------------
 * Helpers (moved from the retired plans.ts)
 * ---------------------------------------------------------------- */

export function extractAssistantText(
  message: unknown,
): string {
  if (
    !message ||
    typeof message !== "object"
  ) {
    return "";
  }

  const msg =
    message as {
      role?: string;
      content?: unknown;
    };

  if (
    msg.role !== "assistant" ||
    !Array.isArray(msg.content)
  ) {
    return "";
  }

  return msg.content
    .filter(
      (
        block,
      ): block is {
        type: "text";
        text: string;
      } =>
        !!block &&
        typeof block === "object" &&
        "type" in block &&
        "text" in block &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export function looksLikePlan(
  text: string,
): boolean {
  if (!text.trim()) {
    return false;
  }

  /*
   * Deliberately permissive: don't discard a valid plan
   * because the model used slightly different Markdown.
   */
  return (
    /(?:^|\n)\s*#{1,6}\s*(?:plan|implementation plan)\b/i.test(
      text,
    ) ||
    /(?:^|\n)\s*(?:\d+\.|-|\*)\s+\S+/m.test(
      text,
    )
  );
}

function getLastAssistant(
  ctx: ExtensionContext,
): {
  id: string;
  text: string;
} | undefined {
  const branch =
    ctx.sessionManager.getBranch();

  for (
    let i = branch.length - 1;
    i >= 0;
    i--
  ) {
    const entry =
      branch[i];

    if (
      entry.type === "message" &&
      entry.message.role ===
        "assistant"
    ) {
      return {
        id: entry.id,
        text: extractAssistantText(
          entry.message,
        ),
      };
    }
  }

  return undefined;
}

/* ----------------------------------------------------------------
 * Read-only bash gating
 * ---------------------------------------------------------------- */

function getCommand(
  command: string,
): string {
  const trimmed =
    command.trim();

  const first =
    trimmed
      .split(/\s+/)[0]
      ?.replace(
        /^command\s+/,
        "",
      );

  return first ?? "";
}

function isSafeCommand(
  command: string,
): boolean {
  /*
   * Deliberately conservative.
   *
   * Pipes, redirects, chaining and substitutions can turn an
   * apparently harmless command into a write operation.
   */
  if (
    command.includes(">") ||
    command.includes(">>") ||
    command.includes("|") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("$(") ||
    command.includes("`")
  ) {
    return false;
  }

  return SAFE_COMMANDS.has(
    getCommand(command),
  );
}

/* ----------------------------------------------------------------
 * Plan mode controller
 * ---------------------------------------------------------------- */

export function createPlanMode(
  pi: ExtensionAPI,
  options: {
    /**
     * Live workflow state. index.ts reassigns its `state`
     * variable on session restore, so we take a getter
     * instead of capturing a stale reference.
     */
    getState(): WorkflowState;

    /**
     * Called when a plan is approved and
     * execution is dispatched. Used by index.ts
     * to record the plan in the session registry.
     */
    onPlanApproved?(
      planText: string,
      planEntryId: string,
    ): void;
  },
): PlanModeController {
  let enabled = false;

  let prompting = false;

  let toolsBeforePlanMode:
    | string[]
    | undefined;

  function enable(
    ctx: ExtensionContext,
  ): void {
    if (enabled) {
      return;
    }

    enabled = true;

    toolsBeforePlanMode =
      pi.getActiveTools();

    // Keep ALL tools active (including write/edit) - the guard enforces read-only
    // This allows the planner to write the plan artifact
    pi.setActiveTools(toolsBeforePlanMode);

    ctx.ui.setStatus(
      "workflow-plan",
      ctx.ui.theme.fg(
        "warning",
        "⏸ plan",
      ),
    );
  }

  function disable(
    ctx: ExtensionContext,
  ): void {
    if (!enabled) {
      return;
    }

    enabled = false;

    if (toolsBeforePlanMode) {
      pi.setActiveTools(
        toolsBeforePlanMode,
      );
    }

    toolsBeforePlanMode =
      undefined;

    ctx.ui.setStatus(
      "workflow-plan",
      undefined,
    );
  }

  /* ----------------------------------------------------------------
   * Approval flow
   *
   * When a planning run settles and the last assistant
   * message looks like a finalized plan, offer:
   *
   * - Approve: switch to the executor model, restore
   *   tools, dispatch the execution turn immediately.
   * - Approve and compact: same, but compact the
   *   planning transcript first so the execution turn
   *   lands on a fresh cache anchor.
   * - Refine plan: stay in plan mode, feed the
   *   feedback back to the planner.
   * ---------------------------------------------------------------- */

  async function approveAndExecute(
    ctx: ExtensionContext,
    planText: string,
    planEntryIdOrArtifactPath: string,
    choice: string,
    activePlan: { artifactPath?: string; previousModel?: { provider: string; modelId: string } } | undefined,
  ): Promise<void> {
    const state = options.getState();
    const artifactPath = activePlan?.artifactPath ?? planEntryIdOrArtifactPath;
    
    // Switch to executor model
    const activated = await activateRole(pi, ctx, state, "executor");
    if (!activated) return;
    
    // Restore previous model if set
    if (activePlan?.previousModel) {
      const model = ctx.modelRegistry.find(activePlan.previousModel.provider, activePlan.previousModel.modelId);
      if (model) {
        await pi.setModel(model);
      }
    }
    
    disable(ctx);
    state.mode = "executing";
    
    // Mark plan as approved
    if (state.activePlan) {
      state.activePlan.status = "approved";
      state.activePlan.updatedAt = new Date().toISOString();
    }
    
    // Record approval
    options.onPlanApproved?.(planText, artifactPath);
    
    const kickoff = `Execute the approved plan at ${artifactPath}.`;
    
    // Set up approved plan injection for before_agent_start
    pendingApprovedInjection = { artifactPath };
    
    if (choice === APPROVE_COMPACT) {
      ctx.compact({
        customInstructions: `Preserve the plan reference ${artifactPath} verbatim.`,
        onComplete: () => pi.sendUserMessage(kickoff),
        onError: () => pi.sendUserMessage(kickoff),
      });
    } else if (choice === APPROVE_FRESH) {
      // Fresh session: dispatch command (agent_settled can't call newSession directly)
      pi.sendUserMessage(`/workflow-execute ${artifactPath}`, { expandPromptTemplates: true });
    } else {
      // Keep context
      pi.sendUserMessage(kickoff);
    }
  }

  pi.on(
    "agent_settled",
    async (
      _event,
      ctx,
    ) => {
      if (!enabled && !pendingProposal) {
        return;
      }

      // Check for pending proposal from xd://propose sentinel
      if (pendingProposal) {
        const { slug } = pendingProposal;
        pendingProposal = undefined;
        
        const state = options.getState();
        const activePlan = state.activePlan;
        
        if (!activePlan || activePlan.slug !== slug) {
          ctx.ui.notify(
            `Proposal slug "${slug}" does not match active plan "${activePlan?.slug ?? "none"}".`,
            "error",
          );
          return;
        }
        
        // Read the artifact from disk
        let artifactText: string;
        try {
          artifactText = await readPlanArtifact(activePlan.artifactPath);
        } catch (e) {
          ctx.ui.notify(
            `Failed to read plan artifact: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
          return;
        }
        
        state.mode = "awaiting_approval";
        
        const proceed = await showPlanView(
          ctx,
          {
            title: extractPlanTitle(artifactText, activePlan.slug.replace(/-/g, " ").toUpperCase()),
            meta: [`Artifact: ${activePlan.artifactPath}`],
            planText: extractPlanText(artifactText),
          },
        );
        
        if (!proceed) {
          return;
        }
        
        const choice = await ctx.ui.select(
          "Approve plan?",
          [APPROVE_FRESH, APPROVE_KEEP, APPROVE_COMPACT, REFINE, CANCEL],
        );
        
        if (!choice || choice === CANCEL) {
          state.mode = "planning";
          return;
        }
        
        if (choice === REFINE) {
          const feedback = await ctx.ui.input("Refinement feedback:");
          if (!feedback?.trim()) {
            return;
          }
          state.mode = "planning";
          pi.sendUserMessage(feedback);
          return;
        }
        
        // Approve: switch to executor, disable plan mode, execute
        await approveAndExecute(ctx, extractPlanText(artifactText), activePlan.artifactPath, choice, activePlan);
        return;
      }
      
      // Fallback: legacy looksLikePlan detection (for backward compat)
      if (!enabled) return;
      if (prompting) return;
      
      const last = getLastAssistant(ctx);
      if (!last || !looksLikePlan(last.text)) return;
      
      prompting = true;
      try {
        if (!ctx.hasUI) {
          const state = options.getState();
          await approveAndExecute(
            ctx,
            last.text,
            last.id,
            APPROVE_KEEP,
            state.activePlan,
          );
          return;
        }
        
        const proceed = await showPlanView(ctx, {
          title: extractPlanTitle(last.text, "Implementation plan"),
          meta: [`Session: ${pi.getSessionName() ?? "(unnamed)"}`],
          planText: last.text,
        });
        
        if (!proceed) return;
        
        const choice = await ctx.ui.select("Approve plan?", [APPROVE_FRESH, APPROVE_KEEP, APPROVE_COMPACT, REFINE, CANCEL]);
        if (!choice || choice === CANCEL) return;
        
        if (choice === REFINE) {
          const feedback = await ctx.ui.input("Refinement feedback:");
          if (!feedback?.trim()) return;
          pi.sendUserMessage(feedback);
          return;
        }
        
        const state = options.getState();
        await approveAndExecute(ctx, last.text, last.id, choice, state.activePlan);
      } finally {
        prompting = false;
      }
    },
  );

  pi.on(
    "tool_call",
    async (event, ctx) => {
      if (!enabled) {
        return;
      }

      // Handle write tool
      if (event.toolName === "write") {
        const input = event.input as { path?: string; content?: string };
        const targetPath = input.path ?? "";
        
        // Check for proposal sentinel
        if (targetPath === "xd://propose") {
          const slug = String(input.content ?? "").trim();
          if (slug) {
            pendingProposal = { slug };
          }
          return {
            block: true,
            reason: "Plan proposed. Opening review UI.",
          };
        }
        
        // Check if path is inside artifact root
        if (isInsideArtifactRoot(ctx.cwd, targetPath)) {
          return; // Allow artifact writes
        }
        
        // Block working tree writes
        return {
          block: true,
          reason: [
            "Plan mode: working tree is read-only.",
            "Write the plan artifact to:",
            `  <cwd>/.pi/plans/<slug>/plan.md`,
          ].join("\n"),
        };
      }
      
      // Handle edit tool
      if (event.toolName === "edit") {
        const input = event.input as { path?: string };
        const targetPath = input.path ?? "";
        
        if (isInsideArtifactRoot(ctx.cwd, targetPath)) {
          return; // Allow artifact edits
        }
        
        return {
          block: true,
          reason: "Plan mode: working tree is read-only. Edit the plan artifact instead.",
        };
      }
      
      // Handle bash tool (existing read-only gate)
      if (event.toolName === "bash") {
        const command =
          event.input.command;

        if (
          typeof command !==
          "string"
        ) {
          return {
            block: true,
            reason:
              "Plan mode only allows read-only bash commands.",
          };
        }

        if (
          !isSafeCommand(command)
        ) {
          return {
            block: true,
            reason: [
              "Plan mode is active.",
              "",
              "Only read-only commands are allowed.",
              "",
              `Blocked command: ${command}`,
            ].join("\n"),
          };
        }
      }
    },
  );

  pi.on(
    "before_agent_start",
    async (_event, ctx) => {
      // Inject approved plan prompt (one-shot)
      if (pendingApprovedInjection) {
        const { artifactPath } = pendingApprovedInjection;
        pendingApprovedInjection = undefined;
        
        return {
          message: {
            customType: "workflow-approved-plan",
            content: `
An implementation plan has been approved.

The authoritative plan is: ${artifactPath}

You MUST read this file before making changes.

After reading:
1. Execute the plan step by step.
2. Verify each step before proceeding.
3. Track progress.
4. If the plan conflicts with compressed conversation context, the artifact is authoritative.
5. If the artifact cannot be read, report the exact error rather than guessing.
`.trim(),
            display: false,
          },
        };
      }
      
      // Planning mode prompt
      if (!enabled) return;
      
      const state = options.getState();
      const activePlan = state.activePlan;
      const artifactPath = activePlan?.artifactPath ?? `<cwd>/.pi/plans/<slug>/plan.md`;
      const slug = activePlan?.slug ?? "<slug>";
      
      return {
        message: {
          customType: "workflow-plan-context",
          content: `
[PLAN MODE ACTIVE]

You are currently planning an implementation.

The working tree is READ-ONLY. You may only write to the plan artifact:
  ${artifactPath}

Your job:
1. Investigate the codebase AND current web information. Dispatch parallel scouts via the subagent tool:
   - \`scout\` agent for codebase recon (architecture, tests, deployment config).
   - \`web-scout\` agent for web research (docs, migration guides, version compatibility) — it has web_search and web_fetch.
   Then aggregate all scout findings into the ## Findings section of the artifact.
2. Write the full implementation plan to ${artifactPath} using the write tool.
3. Submit the plan by writing to the sentinel: write("xd://propose", "${slug}")

Plan format:
- Goal: one sentence
- Findings: relevant files, patterns, architecture
- Implementation steps: numbered, actionable, with files to modify
- Risks and validation steps

After writing the plan, submit via: write("xd://propose", "${slug}")
`.trim(),
          display: false,
        },
      };
    },
  );

  return {
    enable,
    disable,

    isEnabled() {
      return enabled;
    },
  };
}
