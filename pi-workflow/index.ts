import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  activateRole,
  configureRoleModel,
  getRoleModelLabel,
} from "./models.js";

import {
  createPlanMode,
} from "./plan-mode.js";

import {
  createPlansModule,
} from "./plans.js";

import {
  createInitialState,
  type WorkflowRole,
  type WorkflowState,
} from "./state.js";

export default function workflowExtension(
  pi: ExtensionAPI,
) {
  /**
   * ----------------------------------------------------------------
   * WORKFLOW STATE
   * ----------------------------------------------------------------
   *
   * This state lives for the lifetime of the loaded extension.
   *
   * We also restore it from session entries below so explicitly
   * configured workflow models survive session reloads.
   */
  let state: WorkflowState =
    createInitialState();

  /**
   * ----------------------------------------------------------------
   * PLANS REGISTRY + PLAN MODE
   * ----------------------------------------------------------------
   *
   * The plans module owns the session plan registry and
   * the /plans command. Plan mode owns read-only tool
   * restrictions and the approval flow.
   *
   * Construction order note: plansModule is created first
   * because planMode's onPlanApproved callback needs it, and
   * plansModule only touches planMode lazily via getPlanMode().
   */
  const plansModule =
    createPlansModule(pi, {
      getState: () => state,

      save: () => {
        saveState();
      },

      getPlanMode: () => planMode,
    });

  const planMode =
    createPlanMode(pi, {
      getState: () => state,

      onPlanApproved: (
        planText: string,
        planEntryId: string,
      ) => {
        plansModule.recordApproval(
          planText,
          planEntryId,
        );
      },
    });

  /**
   * ----------------------------------------------------------------
   * RESTORE WORKFLOW STATE
   * ----------------------------------------------------------------
   *
   * Persisted "workflow-state" entries are replayed by
   * scanning the session entries on session_start (the
   * old session_entry replay hook no longer exists in pi).
   *
   * We only restore state that was explicitly persisted by
   * this extension: role model overrides and the plan registry.
   */
  pi.on("session_start", async (_event, ctx) => {
    state = createInitialState();

    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== "workflow-state"
      ) {
        continue;
      }

      const data = entry.data;

      if (
        !data ||
        typeof data !== "object"
      ) {
        continue;
      }

      const workflowState =
        data as WorkflowState;

      if (
        workflowState.version !== 1
      ) {
        continue;
      }

      state = {
        version: 1,

        models:
          workflowState.models ?? {},

        plans:
          workflowState.plans ?? [],

        nextPlanId:
          workflowState.nextPlanId,
      };
    }

    planMode.disable(ctx);
  });

  /**
   * ----------------------------------------------------------------
   * SAVE STATE
   * ----------------------------------------------------------------
   *
   * IMPORTANT:
   *
   * We only persist explicit role overrides.
   *
   * If a role is absent from `state.models`, that means:
   *
   * "Use whatever model Pi currently has selected."
   *
   * We never automatically save ctx.model here.
   */
  function saveState(): void {
    pi.appendEntry(
      "workflow-state",
      {
        version: 1,
        models: state.models,

        plans: state.plans ?? [],

        nextPlanId: state.nextPlanId,
      },
    );
  }

  /**
   * ----------------------------------------------------------------
   * /workflow-models
   * ----------------------------------------------------------------
   *
   * Configure model overrides for:
   *
   * - planner
   * - scout
   * - executor
   * - reviewer
   *
   * Example:
   *
   * planner  -> Opus 4.8
   * scout    -> DeepSeek V4 Flash
   * executor -> Sonnet 4.6
   * reviewer -> Opus 4.8
   *
   * If a role is configured as "Use current Pi model dynamically",
   * its override is deleted.
   */
  pi.registerCommand("workflow-models", {
    description:
      "Configure models for planner, scout, executor, and reviewer",

    handler: async (
      _args: string,
      ctx: ExtensionContext,
    ) => {
      await ctx.waitForIdle();

      const roles: WorkflowRole[] = [
        "planner",
        "scout",
        "executor",
        "reviewer",
      ];

      while (true) {
        const options =
          [
            ...roles.map(
              (role) => {
                const label =
                  getRoleModelLabel(
                    state,
                    role,
                    ctx,
                  );

                return `${role}: ${label}`;
              },
            ),
            "Done",
          ];

        const selected =
          await ctx.ui.select(
            "Workflow Models",
            options,
          );

        if (
          !selected ||
          selected === "Done"
        ) {
          return;
        }

        const role =
          roles.find(
            (candidate) =>
              selected.startsWith(
                `${candidate}:`,
              ),
          );

        if (!role) {
          continue;
        }

        await configureRoleModel(
          pi,
          ctx,
          state,
          role,
          saveState,
        );
      }
    },
  });

  /**
   * ----------------------------------------------------------------
   * /plan
   * ----------------------------------------------------------------
   *
   * Usage:
   *
   * /plan <task>
   *
   * Example:
   *
   * /plan Implement a transition animation when navigating between screens
   *
   * Flow:
   *
   * 1. Wait for Pi to become idle.
   * 2. Activate planner model IF explicitly configured.
   * 3. Otherwise preserve the currently selected Pi model.
   * 4. Enable read-only plan mode.
   * 5. Persist workflow metadata.
   * 6. Send the actual task as a user message.
   * 7. Pi starts a real LLM turn.
   *
   * This last step is what prevents:
   *
   * Messages: 0
   * Assistant: 0
   *
   * which happened with our earlier implementation.
   */
  pi.registerCommand("plan", {
    description:
      "Create an implementation plan using the planner model",

    handler: async (
      args: string,
      ctx: ExtensionContext,
    ) => {
      const task =
        args.trim();

      if (!task) {
        ctx.ui.notify(
          [
            "Usage:",
            "/plan <what you want to plan>",
            "",
            "Example:",
            "/plan Implement a transition animation when navigating between screens",
          ].join("\n"),
          "info",
        );

        return;
      }

      /**
       * Prevent overlapping planning runs.
       *
       * We intentionally do this before changing models or tools.
       */
      if (
        !ctx.isIdle()
      ) {
        ctx.ui.notify(
          "Waiting for the current agent run to finish...",
          "info",
        );

        await ctx.waitForIdle();
      }

      /**
       * If an old planning mode is still active, cleanly reset it
       * before starting the new planning run.
       *
       * This avoids the previous:
       *
       * "Warning: A planning run is already active."
       */
      if (
        planMode.isEnabled()
      ) {
        planMode.disable(ctx);
      }

      /**
       * Activate the planner role.
       *
       * IMPORTANT:
       *
       * If planner has no explicit model override, activateRole()
       * deliberately does nothing.
       *
       * Therefore:
       *
       * /model deepseek-v4-flash
       * /plan ...
       *
       * stays on DeepSeek.
       */
      const activated =
        await activateRole(
          pi,
          ctx,
          state,
          "planner",
        );

      if (!activated) {
        return;
      }

      /**
       * Enable Pi-style read-only planning.
       */
      planMode.enable(ctx);

      /**
       * Persist workflow metadata.
       *
       * This is NOT the actual plan itself.
       *
       * The actual planning conversation is stored normally in the
       * Pi session because sendUserMessage() below creates a real
       * user message and triggers the agent.
       */
      pi.appendEntry(
        "workflow-plan-start",
        {
          task,
          startedAt:
            new Date().toISOString(),

          model: {
            provider:
              ctx.model?.provider ??
              null,

            modelId:
              ctx.model?.id ??
              null,
          },
        },
      );

      /**
       * CRITICAL:
       *
       * This actually starts the LLM turn.
       *
       * The previous implementation changed extension state but
       * never sent a message to the agent, resulting in sessions
       * with:
       *
       * Messages: 0
       * User: 0
       * Assistant: 0
       */
      pi.sendUserMessage(
        task,
      );
    },
  });

  /**
   * ----------------------------------------------------------------
   * /plan-off
   * ----------------------------------------------------------------
   *
   * Explicitly leave planning mode.
   *
   * This restores the tools that were active before /plan.
   */
  pi.registerCommand("plan-off", {
    description:
      "Exit workflow planning mode",

    handler: async (
      _args: string,
      ctx: ExtensionContext,
    ) => {
      if (
        !planMode.isEnabled()
      ) {
        ctx.ui.notify(
          "Plan mode is not active.",
          "info",
        );

        return;
      }

      if (
        !ctx.isIdle()
      ) {
        await ctx.waitForIdle();
      }

      planMode.disable(ctx);

      pi.appendEntry(
        "workflow-plan-end",
        {
          endedAt:
            new Date().toISOString(),
        },
      );

      ctx.ui.notify(
        "Plan mode disabled. Tools restored.",
        "info",
      );
    },
  });

  /**
   * ----------------------------------------------------------------
   * /workflow-status
   * ----------------------------------------------------------------
   *
   * Useful while we are building the workflow.
   *
   * Shows:
   *
   * - active Pi model
   * - configured model override for each role
   * - whether plan mode is active
   * - plan registry summary
   */
  pi.registerCommand("workflow-status", {
    description:
      "Show workflow status and model assignments",

    handler: async (
      _args: string,
      ctx: ExtensionContext,
    ) => {
      const roles: WorkflowRole[] = [
        "planner",
        "scout",
        "executor",
        "reviewer",
      ];

      const activeModel =
        ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "Unknown";

      const roleLines =
        roles.map(
          (role) =>
            `${role}: ${getRoleModelLabel(
              state,
              role,
              ctx,
            )}`,
        );

      const plans =
        state.plans ?? [];

      const activePlans =
        plans.filter(
          (plan) =>
            plan.status ===
            "active",
        ).length;

      ctx.ui.notify(
        [
          "Workflow Status",
          "",
          `Active Pi model: ${activeModel}`,
          `Plan mode: ${planMode.isEnabled()
            ? "active"
            : "inactive"
          }`,
          `Plans: ${plans.length} (${activePlans} active)`,
          "",
          "Role models:",
          ...roleLines,
        ].join("\n"),
        "info",
      );
    },
  });
}
