/**
 * Mode-independent ask_user logic: the RPC dialog path and the no-UI result.
 * No pi-tui / pi-coding-agent runtime imports so the self-check can run standalone.
 */
import type { AskOption, AskUserParams, AskUserResult } from "./types";

/** Minimal UI surface the RPC path needs (structurally compatible with ctx.ui). */
export interface RpcUI {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
}

export function optionValue(opt: AskOption): string {
  return opt.value ?? opt.label;
}

export function recommendedOption(params: AskUserParams): AskOption | undefined {
  return params.options?.find((o) => o.recommended);
}

/** Result returned when no interactive UI is available (print/json modes). */
export function unavailableResult(params: AskUserParams): AskUserResult {
  const rec = recommendedOption(params);
  return {
    kind: "unavailable",
    questionId: params.id,
    recommended: rec ? optionValue(rec) : undefined,
  };
}

function optionDisplay(opt: AskOption): string {
  let s = opt.label;
  if (opt.recommended) s += " (recommended)";
  if (opt.description) s += ` — ${opt.description}`;
  return s;
}

type RpcEntry =
  | { kind: "opt"; option: AskOption }
  | { kind: "other" }
  | { kind: "chat" };

/**
 * Ask a question over RPC-style dialog primitives. `custom()` is a no-op in
 * RPC mode, so this path uses only select/confirm/input, which do block for a
 * matching extension_ui_response.
 */
export async function rpcAsk(params: AskUserParams, ui: RpcUI): Promise<AskUserResult> {
  const opts = params.options ?? [];
  const allowOther = params.allowOther !== false;
  const questionId = params.id;

  // Free text: no options supplied.
  if (opts.length === 0) {
    const text = await ui.input(params.question, "");
    if (text === undefined) return { kind: "cancelled", questionId };
    return { kind: "answer", questionId, selected: [text.trim()] };
  }

  if (params.multi) {
    const selected: string[] = [];
    for (const o of opts) {
      const ok = await ui.confirm(params.question, optionDisplay(o));
      if (ok) selected.push(optionValue(o));
    }
    let customInput: string | undefined;
    if (allowOther) {
      const wantOther = await ui.confirm(params.question, "Other… (supply a custom answer)");
      if (wantOther) {
        const text = await ui.input(params.question, "");
        if (text !== undefined) customInput = text.trim();
      }
    }
    const wantChat = await ui.confirm(params.question, "Chat… (switch to free-form conversation)");
    if (wantChat) return { kind: "chat", questionId };

    if (selected.length === 0 && customInput === undefined) {
      return { kind: "cancelled", questionId };
    }
    return { kind: "answer", questionId, selected, customInput };
  }

  // Single select.
  const entries: RpcEntry[] = opts.map((o) => ({ kind: "opt", option: o }) as RpcEntry);
  if (allowOther) entries.push({ kind: "other" });
  entries.push({ kind: "chat" });

  const labels = entries.map((e) =>
    e.kind === "opt"
      ? optionDisplay(e.option)
      : e.kind === "other"
        ? "Other… (type a custom answer)"
        : "Chat… (switch to free-form conversation)",
  );

  const choice = await ui.select(params.question, labels);
  if (choice === undefined) return { kind: "cancelled", questionId };

  const idx = labels.indexOf(choice);
  const entry = entries[idx];
  if (!entry) return { kind: "cancelled", questionId };

  if (entry.kind === "opt") {
    return { kind: "answer", questionId, selected: [optionValue(entry.option)] };
  }
  if (entry.kind === "chat") return { kind: "chat", questionId };

  // Other… — free text.
  const text = await ui.input(params.question, "");
  if (text === undefined) return { kind: "cancelled", questionId };
  return { kind: "other", questionId, customInput: text.trim() };
}
