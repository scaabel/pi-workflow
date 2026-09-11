import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  Container,
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Text,
} from "@mariozechner/pi-tui";

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

/**
 * Searchable, scrollable model picker component.
 *
 * Combines an Input (search box) with a SelectList (fuzzy-filtered results).
 * Implements Focusable to propagate focus to the Input for IME cursor positioning.
 */
class ModelPicker implements Component, Focusable {
  private items: SelectItem[];
  private theme: any;
  private keybindings: any;
  private input: Input;
  private list: SelectList;
  private container: Container;
  private onSelect: (value: string) => void;
  private onCancel: () => void;
  private query = "";
  private _focused = false;

  constructor(
    items: SelectItem[],
    theme: any,
    keybindings: any,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    this.items = items;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.input = new Input();
    this.container = new Container();
    this.container.addChild(this.input);
    this.container.addChild(new Text("", 0, 1)); // spacer
    this.list = this.buildList(items);
    this.container.addChild(this.list);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "  No matching models"),
    }, {
      minPrimaryColumnWidth: 36,
      maxPrimaryColumnWidth: 56,
    });
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = () => this.onCancel();
    return list;
  }

  private refilter() {
    const filtered = this.query
      ? fuzzyFilter(this.items, this.query, (it) => `${it.value} ${it.description ?? ""}`)
      : this.items;
    const newList = this.buildList(filtered);
    this.container.clear();
    this.container.addChild(this.input);
    this.container.addChild(new Text("", 0, 1)); // spacer
    this.container.addChild(newList);
    this.list = newList;
  }

  handleInput(data: string) {
    // Navigation and confirm go to the list
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm")
    ) {
      this.list.handleInput(data);
      return;
    }

    // Cancel: clear query first if present, otherwise cancel
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.query) {
        this.input.setValue("");
        this.query = "";
        this.refilter();
        return;
      }
      this.onCancel();
      return;
    }

    // Everything else (typing, backspace, cursor movement) goes to Input
    this.input.handleInput(data);
    const q = this.input.getValue().trim();
    if (q !== this.query) {
      this.query = q;
      this.refilter();
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate() {
    this.container.invalidate();
  }
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
    state.models[role] = null;

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

  // Build SelectItem array for the picker
  const items: SelectItem[] = models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.id}`,
    description: model.name,
  }));

  // Show searchable, scrollable model picker
  const selected = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const container = new Container();

    // Top border
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    // Title
    container.addChild(new Text(theme.fg("accent", theme.bold(`Select ${role} model`)), 1, 0));

    // Model picker component (includes search input + scrollable list)
    const picker = new ModelPicker(items, theme, keybindings, done, () => done(null));
    container.addChild(picker);

    // Footer hint
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));

    // Bottom border
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!selected) {
    return;
  }

  // Find the model by provider/id (more robust than string indexOf)
  const model = models.find((m) => `${m.provider}/${m.id}` === selected);

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
