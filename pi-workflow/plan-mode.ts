import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { activateRole } from "./models.js";

import {
  extractPlanTitle,
  showPlanView,
} from "./plan-view.js";

import type {
  WorkflowState,
} from "./state.js";

const WRITE_TOOLS = new Set([
  "edit",
  "write",
]);

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

const APPROVE = "Approve";
const APPROVE_AND_COMPACT =
  "Approve and compact context";
const REFINE = "Refine plan";

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

    const planTools =
      toolsBeforePlanMode.filter(
        (tool) =>
          !WRITE_TOOLS.has(tool),
      );

    pi.setActiveTools(planTools);

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
    planEntryId: string,
    compactFirst: boolean,
  ): Promise<void> {
    /*
     * Switch to the executor model BEFORE dispatching,
     * so the execution turn runs on it.
     *
     * activateRole() no-ops when no override is
     * configured (keeps the current model) and notifies
     * on failure, in which case we stay in plan mode.
     */
    const activated =
      await activateRole(
        pi,
        ctx,
        options.getState(),
        "executor",
      );

    if (!activated) {
      return;
    }

    disable(ctx);

    pi.setLabel(
      planEntryId,
      "plan-approved",
    );

    pi.appendEntry(
      "workflow-plan-approved",
      {
        entryId:
          planEntryId,
        at: new Date()
          .toISOString(),
        executor: {
          provider:
            ctx.model?.provider ??
            null,
          modelId:
            ctx.model?.id ?? null,
        },
      },
    );

    options.onPlanApproved?.(
      planText,
      planEntryId,
    );

    const kickoff = [
      "Plan approved. Execute it now.",
      "",
      planText,
    ].join("\n");

    if (compactFirst) {
      ctx.compact({
        customInstructions:
          "Preserve the implementation plan and key findings verbatim.",
        onComplete: () => {
          pi.sendUserMessage(
            kickoff,
          );
        },
        onError: () => {
          /*
           * Compaction failed: still execute,
           * just with the full context.
           */
          pi.sendUserMessage(
            kickoff,
          );
        },
      });

      return;
    }

    pi.sendUserMessage(
      kickoff,
    );
  }

  pi.on(
    "agent_settled",
    async (
      _event,
      ctx,
    ) => {
      if (
        !enabled ||
        prompting
      ) {
        return;
      }

      const last =
        getLastAssistant(
          ctx,
        );

      if (
        !last ||
        !looksLikePlan(
          last.text,
        )
      ) {
        return;
      }

      prompting = true;

      try {
        /*
         * No UI (print/json mode): auto-approve.
         */
        if (!ctx.hasUI) {
          await approveAndExecute(
            ctx,
            last.text,
            last.id,
            false,
          );

          return;
        }

        /*
         * Review the plan in the split-pane
         * view before offering the selector.
         * Escape in the view stays in plan
         * mode (same as escaping the selector).
         */
        const proceed =
          await showPlanView(
            ctx,

            {
              title:
                extractPlanTitle(
                  last.text,

                  "Implementation plan",
                ),

              meta: [
                `Session: ${
                  pi.getSessionName() ??
                  "(unnamed)"
                }`,
              ],

              planText:
                last.text,
            },
          );

        if (
          !proceed
        ) {
          return;
        }

        const choice =
          await ctx.ui.select(
            "Approve plan?",
            [
              APPROVE,
              APPROVE_AND_COMPACT,
              REFINE,
            ],
          );

        /*
         * Escape / no choice: stay in plan mode.
         */
        if (!choice) {
          return;
        }

        if (
          choice === REFINE
        ) {
          const feedback =
            await ctx.ui.input(
              "Refinement feedback:",
            );

          if (
            !feedback?.trim()
          ) {
            return;
          }

          /*
           * Stay in plan mode. The next
           * agent_settled re-offers the
           * selector on the revised plan.
           */
          pi.sendUserMessage(
            feedback,
          );

          return;
        }

        await approveAndExecute(
          ctx,
          last.text,
          last.id,
          choice ===
            APPROVE_AND_COMPACT,
        );
      } finally {
        prompting = false;
      }
    },
  );

  pi.on(
    "tool_call",
    async (event) => {
      if (!enabled) {
        return;
      }

      if (
        event.toolName !== "bash"
      ) {
        return;
      }

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
    },
  );

  pi.on(
    "before_agent_start",
    async () => {
      if (!enabled) {
        return;
      }

      return {
        message: {
          customType:
            "workflow-plan-context",

          content: `
[PLAN MODE ACTIVE]

You are currently planning an implementation.

Your job is to investigate the codebase and produce
an implementation plan.

Rules:

- Do not modify files.
- Do not use destructive or state-changing commands.
- Inspect relevant files before making assumptions.
- Use available read-only tools to understand the existing architecture.
- If important requirements are ambiguous, ask the user for clarification.
- Consider existing patterns and conventions in the repository.

When you have enough information, produce the final plan
using exactly this structure:

Plan:
1. <first implementation step>
2. <second implementation step>
3. <third implementation step>

For every step, explain:

- What will change.
- Which files or areas are affected.
- Why the change is necessary.

End your turn immediately after presenting the plan.

Do not implement the plan yet.
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
