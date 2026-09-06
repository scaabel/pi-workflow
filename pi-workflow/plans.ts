/**
 * Plan registry + /plans command.
 *
 * Tracks every plan approved in this session with a status,
 * and offers per-plan actions (resume, revise, view,
 * compare, abandon).
 */
import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readPlanArtifact, extractPlanText } from "./artifacts.js";

import { activateRole } from "./models.js";

import {
  extractAssistantText,
  type PlanModeController,
} from "./plan-mode.js";

import {
  extractPlanTitle,
  showPlanView,
} from "./plan-view.js";

import type {
  PlanRecord,
  PlanStatus,
  WorkflowState,
} from "./state.js";

const STATUS_META: Record<
  PlanStatus,
  {
    icon: string;
    label: string;
  }
> = {
  active: {
    icon: "●",
    label: "ACTIVE",
  },

  partial: {
    icon: "◐",
    label: "PARTIALLY IMPLEMENTED",
  },

  superseded: {
    icon: "○",
    label: "NOT IMPLEMENTED",
  },

  abandoned: {
    icon: "✗",
    label: "ABANDONED",
  },
};

function relTime(
  timestamp: number,
): string {
  const seconds = Math.max(
    0,

    Math.floor(
      (Date.now() -
        timestamp) /
        1000,
    ),
  );

  if (
    seconds < 60
  ) {
    return "just now";
  }

  const minutes = Math.floor(
    seconds / 60,
  );

  if (
    minutes < 60
  ) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(
    minutes / 60,
  );

  if (
    hours < 24
  ) {
    return `${hours}h ago`;
  }

  const days = Math.floor(
    hours / 24,
  );

  return `${days}d ago`;
}

export interface PlansModule {
  /**
   * Called by the approval flow when a plan
   * is approved and execution is dispatched.
   */
  recordApproval(
    planText: string,
    planEntryId: string,
  ): void;
}

export function createPlansModule(
  pi: ExtensionAPI,
  options: {
    getState(): WorkflowState;
    save(): void;
    getPlanMode(): PlanModeController;
  },
): PlansModule {
  /**
   * Set when the user chose "Revise plan";
   * consumed by the next recordApproval so
   * the revised plan links to its origin.
   */
  let revisionOriginId:
    | number
    | undefined;

  function demoteActivePlans(
    state: WorkflowState,
  ): void {
    for (const plan of state
      .plans ?? []) {
      if (
        plan.status ===
        "active"
      ) {
        plan.status =
          plan.dispatched
            ? "partial"
            : "superseded";
      }
    }
  }

  function promote(
    state: WorkflowState,
    plan: PlanRecord,
  ): void {
    demoteActivePlans(
      state,
    );

    plan.status =
      "active";

    plan.dispatched =
      true;
  }

  function recordApproval(
    planText: string,
    planEntryIdOrArtifactPath: string,
  ): void {
    const state = options.getState();
    const plans = state.plans ?? [];
    demoteActivePlans(state);

    const id = state.nextPlanId ?? (plans.length > 0 ? Math.max(...plans.map((p) => p.id)) + 1 : 1);
    const activePlan = state.activePlan;
    const artifactPath = activePlan?.artifactPath ?? planEntryIdOrArtifactPath;
    const slug = activePlan?.slug ?? `plan-${id}`;

    const record: PlanRecord = {
      id,
      title: extractPlanTitle(planText, `Plan ${id}`),
      planEntryId: artifactPath,
      status: "active",
      createdAt: Date.now(),
      dispatched: true,
      artifactPath,
      slug,
    };

    if (revisionOriginId !== undefined) {
      record.revisedFromId = revisionOriginId;
      revisionOriginId = undefined;
    }

    state.plans = [...plans, record];
    state.nextPlanId = id + 1;
    options.save();
  }

  async function getPlanText(
    ctx: ExtensionContext,
    plan: PlanRecord,
  ): Promise<string> {
    // Prefer artifact file (survives compaction)
    if (plan.artifactPath) {
      try {
        const content = await fs.promises.readFile(plan.artifactPath, "utf-8");
        return extractPlanText(content);
      } catch {
        // Fall through to session entry
      }
    }
    
    // Fallback: session entry
    const entry = ctx.sessionManager.getEntry(plan.planEntryId);
    if (!entry || entry.type !== "message") return "";
    return extractAssistantText(entry.message);
  }

  async function compareChanges(
    ctx: ExtensionContext,
  ): Promise<void> {
    const stat =
      await pi.exec(
        "git",

        [
          "diff",
          "--stat",
        ],

        {
          timeout:
            10_000,
        },
      );

    if (
      stat.code !==
      0
    ) {
      ctx.ui.notify(
        "Not a git repository (or git failed).",
        "warning",
      );

      return;
    }

    const status =
      await pi.exec(
        "git",

        [
          "status",
          "--short",
        ],

        {
          timeout:
            10_000,
        },
      );

    const parts: string[] =
      [];

    if (
      status.stdout
        .trim()
    ) {
      parts.push(
        `Changed files:\n${status.stdout.trim()}`,
      );
    }

    if (
      stat.stdout.trim()
    ) {
      parts.push(
        `Diff stat:\n${stat.stdout.trim()}`,
      );
    }

    ctx.ui.notify(
      parts.join(
        "\n\n",
      ) ||
        "No uncommitted changes.",

      "info",
    );
  }

  async function showPlanActions(ctx: ExtensionContext, plan: PlanRecord): Promise<void> {
    const planMode = options.getPlanMode();
    const planText = await getPlanText(ctx, plan);
    const meta = STATUS_META[plan.status];

    ctx.ui.notify([`Plan ${plan.id}: ${plan.title}`, `Status: ${meta.label}`, `Created: ${relTime(plan.createdAt)}`].join("\n"), "info");

    const action = await ctx.ui.select(`Plan ${plan.id}: ${plan.title}`, ["Resume implementation", "Revise plan", "View plan", "Compare with current changes", "Mark abandoned"]);
    if (!action) return;

    if (action === "View plan") {
      if (!planText) {
        ctx.ui.notify("Plan text not found.", "error");
        return;
      }
      await showPlanView(ctx, {
        title: `Plan ${plan.id}: ${plan.title}`,
        meta: [`Status: ${meta.label}`, `Created: ${relTime(plan.createdAt)}`],
        planText,
        proceedLabel: "close",
      });
      return;
    }

    if (action === "Compare with current changes") {
      await compareChanges(ctx);
      return;
    }

    if (action === "Mark abandoned") {
      plan.status = "abandoned";
      options.save();
      ctx.ui.notify(`Plan ${plan.id} marked abandoned.`, "info");
      return;
    }

    if (!planText) {
      ctx.ui.notify("Plan text not found.", "error");
      return;
    }

    if (action === "Revise plan") {
      revisionOriginId = plan.id;
      if (!planMode.isEnabled()) planMode.enable(ctx);
      pi.sendUserMessage(["Revise this plan:", "", planText, ""].join("\n"));
      return;
    }

    // Resume implementation
    const activated = await activateRole(pi, ctx, options.getState(), "executor");
    if (!activated) return;

    planMode.disable(ctx);
    promote(options.getState(), plan);
    options.save();

    pi.sendUserMessage(["Resume implementation:", "", planText].join("\n"));
  }

  pi.registerCommand(
    "plans",

    {
      description:
        "List plans in this session",

      handler: async (
        _args: string,
        ctx: ExtensionContext,
      ) => {
        const state =
          options.getState();

        const plans = [
          ...(state.plans ??
            []),
        ].sort(
          (
            a,
            b,
          ) =>
            b.id -
            a.id,
        );

        if (
          plans.length ===
          0
        ) {
          ctx.ui.notify(
            "No plans in this session yet. Start one with /plan <task>.",
            "info",
          );

          return;
        }

        const labels =
          plans.map(
            (
              plan,
            ) => {
              const meta =
                STATUS_META[
                  plan
                    .status
                ];

              return `${meta.icon} Plan ${plan.id}  ${plan.title}  ·  ${meta.label}  ·  ${relTime(plan.createdAt)}`;
            },
          );

        if (
          !ctx.hasUI
        ) {
          ctx.ui.notify(
            labels.join(
              "\n",
            ),

            "info",
          );

          return;
        }

        const choice =
          await ctx.ui.select(
            `Plans (${plans.length})`,

            labels,
          );

        if (
          !choice
        ) {
          return;
        }

        const plan =
          plans[
            labels.indexOf(
              choice,
            )
          ];

        if (
          plan
        ) {
          await showPlanActions(
            ctx,
            plan,
          );
        }
      },
    },
  );

  return {
    recordApproval,
  };
}
