import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import type {
  ModelRef,
  WorkflowRole,
  WorkflowState,
} from "./state.js";

export function getRoleModel(
  state: WorkflowState,
  role: WorkflowRole,
): ModelRef | undefined {
  return state.models[role];
}

/**
 * Activate a model assigned to a workflow role.
 *
 * IMPORTANT:
 *
 * If no model is explicitly assigned, we deliberately do nothing.
 *
 * This preserves the model selected through Pi's native /model command.
 */
export async function activateRole(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  role: WorkflowRole,
): Promise<boolean> {
  const ref = getRoleModel(state, role);

  // No override = preserve Pi's current model.
  if (!ref) {
    return true;
  }

  const model = ctx.modelRegistry.find(
    ref.provider,
    ref.modelId,
  );

  if (!model) {
    ctx.ui.notify(
      [
        `Workflow model not found for ${role}:`,
        `${ref.provider}/${ref.modelId}`,
        "",
        "Use /workflow-models to configure it again.",
      ].join("\n"),
      "error",
    );

    return false;
  }

  const success = await pi.setModel(model);

  if (!success) {
    ctx.ui.notify(
      [
        `Unable to activate ${role} model:`,
        `${ref.provider}/${ref.modelId}`,
        "",
        "Pi could not find valid credentials for this model.",
      ].join("\n"),
      "error",
    );

    return false;
  }

  if (ref.thinkingLevel) {
    pi.setThinkingLevel(
      ref.thinkingLevel as never,
    );
  }

  return true;
}

export function getRoleModelLabel(
  state: WorkflowState,
  role: WorkflowRole,
  ctx: ExtensionContext,
): string {
  const ref = getRoleModel(state, role);

  if (ref) {
    return `${ref.provider}/${ref.modelId}`;
  }

  if (ctx.model) {
    return `Current: ${ctx.model.provider}/${ctx.model.id}`;
  }

  return "No model";
}

/**
 * Build the list from Pi's actual model registry.
 *
 * This avoids hardcoding OpenCode, Anthropic, DeepSeek, etc.
 */
export function getAvailableModels(
  ctx: ExtensionContext,
) {
  return ctx.modelRegistry.getAvailable();
}

export async function configureRoleModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  role: WorkflowRole,
  save: () => void,
): Promise<void> {
  const current = getRoleModel(state, role);

  const action = await ctx.ui.select(
    `${role} model`,
    [
      current
        ? `Change (${current.provider}/${current.modelId})`
        : "Choose model",
      "Use current Pi model dynamically",
      "Cancel",
    ],
  );

  if (!action || action === "Cancel") {
    return;
  }

  /**
   * This does NOT save ctx.model.
   *
   * Deleting the role override means the role will simply use
   * whatever Pi model is active when /plan, /execute, etc. runs.
   */
  if (action === "Use current Pi model dynamically") {
    delete state.models[role];

    save();

    ctx.ui.notify(
      `${role} will use Pi's currently selected model.`,
      "info",
    );

    return;
  }

  const models = getAvailableModels(ctx);

  if (models.length === 0) {
    ctx.ui.notify(
      "Pi has no available models.",
      "error",
    );

    return;
  }

  const options = models.map(
    (model) =>
      `${model.provider}/${model.id}${model.name ? ` — ${model.name}` : ""
      }`,
  );

  const selected = await ctx.ui.select(
    `Select ${role} model`,
    options,
  );

  if (!selected) {
    return;
  }

  const index = options.indexOf(selected);

  const model = models[index];

  if (!model) {
    return;
  }

  state.models[role] = {
    provider: model.provider,
    modelId: model.id,
  };

  save();

  ctx.ui.notify(
    `${role} → ${model.provider}/${model.id}`,
    "info",
  );
}
