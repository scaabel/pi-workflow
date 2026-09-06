import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  createPlanArtifact,
  slugify,
} from "./artifacts.js";

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
  DEFAULT_ROLE_MODELS,
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
        models: { ...DEFAULT_ROLE_MODELS, ...(workflowState.models ?? {}) },
        plans: workflowState.plans ?? [],
        nextPlanId: workflowState.nextPlanId,
        mode: "normal", // Reset mode on session restore
        activePlan: undefined, // Active plan is session-scoped
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
    pi.appendEntry("workflow-state", {
      version: 1,
      models: state.models,
      plans: state.plans ?? [],
      nextPlanId: state.nextPlanId,
      mode: state.mode,
      activePlan: state.activePlan,
    });
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
   */
  pi.registerCommand("plan", {
    description: "Create an implementation plan using the planner model",

    handler: async (args: string, ctx: ExtensionContext) => {
      const task = args.trim();

      if (!task) {
        ctx.ui.notify("Usage: /plan <what you want to plan>", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Waiting for the current agent run to finish...", "info");
        await ctx.waitForIdle();
      }

      if (planMode.isEnabled()) {
        planMode.disable(ctx);
      }

      const activated = await activateRole(pi, ctx, state, "planner");
      if (!activated) return;

      // Create artifact
      const slug = slugify(task);
      const { artifactPath } = await createPlanArtifact(ctx.cwd, slug, task);
      
      // Capture previous model for restoration
      const previousModel = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;

      // Set up active plan
      state.mode = "planning";
      state.activePlan = {
        id: `plan_${Date.now()}`,
        slug,
        artifactPath,
        status: "planning",
        request: task,
        previousModel,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      planMode.enable(ctx);
      saveState();

      pi.sendUserMessage(task);
    },
  });

  /**
   * ----------------------------------------------------------------
   * /plan-off
   * ----------------------------------------------------------------
   */
  pi.registerCommand("plan-off", {
    description: "Exit workflow planning mode",

    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!planMode.isEnabled()) {
        ctx.ui.notify("Plan mode is not active.", "info");
        return;
      }

      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
      }

      planMode.disable(ctx);
      state.mode = "normal";
      saveState();

      ctx.ui.notify("Plan mode disabled. Tools restored.", "info");
    },
  });

  /**
   * ----------------------------------------------------------------
   * /workflow-execute (internal: fresh session execution)
   * ----------------------------------------------------------------
   */
  pi.registerCommand("workflow-execute", {
    description: "Execute an approved plan in a fresh session (internal)",

    handler: async (args: string, ctx) => {
      const artifactPath = args.trim();
      if (!artifactPath) {
        ctx.ui.notify("Usage: /workflow-execute <artifactPath>", "warning");
        return;
      }

      // Restore previous model if available in state
      const activePlan = state.activePlan;
      if (activePlan?.previousModel) {
        const model = ctx.modelRegistry.find(activePlan.previousModel.provider, activePlan.previousModel.modelId);
        if (model) {
          await pi.setModel(model);
        }
      }

      const kickoff = `Execute the approved plan at ${artifactPath}.`;

      await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.sendUserMessage(kickoff);
        },
      });
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
