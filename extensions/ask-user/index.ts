/**
 * ask_user extension — a generic, blocking "ask the user" tool.
 *
 * The extension is a dumb interaction primitive: it never decides what to ask.
 * The LLM decides, calls ask_user, and the tool blocks on ctx.ui until the
 * user answers, then returns the structured result as JSON.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { rpcAsk, unavailableResult } from "./dialog";
import { tuiAsk } from "./tui";
import type { AskUserParams, AskUserResult } from "./types";

const AskOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
  value: Type.Optional(Type.String({ description: "Value returned when selected; defaults to the label" })),
  recommended: Type.Optional(Type.Boolean({ description: "Mark exactly one option as the recommended answer" })),
});

const AskUserParamsSchema = Type.Object({
  id: Type.String({ description: "Stable identifier for this decision, e.g. 'recurrence-model'" }),
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Optional(Type.Array(AskOptionSchema, { description: "Options to choose from. Omit for a free-text answer." })),
  multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default false)", default: false })),
  allowOther: Type.Optional(Type.Boolean({ description: "Show an 'Other…' free-text entry (default true)", default: true })),
  multiline: Type.Optional(Type.Boolean({ description: "Prefer a multiline editor for free text (default false)", default: false })),
});

interface AskUserDetails {
  result: AskUserResult;
  question: string;
}

const RESULT_JSON_DOC =
  'The result is JSON: {kind:"answer",selected:[...]} (user picked your options, or typed text when no options were offered), ' +
  '{kind:"other",customInput} (user typed a custom answer instead of your options), ' +
  '{kind:"chat"} (user wants to answer in free-form chat — stop and let them type), ' +
  '{kind:"cancelled"} (user dismissed the question), ' +
  '{kind:"unavailable"} (no UI available — proceed with the recommended option).';

async function askUser(params: AskUserParams, ctx: ExtensionContext): Promise<AskUserResult> {
  if (!ctx.hasUI) return unavailableResult(params);
  if (ctx.mode === "tui") return tuiAsk(params, ctx);
  // RPC mode: hasUI is true but ctx.ui.custom() is a no-op, so use dialog primitives.
  return rpcAsk(params, ctx.ui);
}

export default function askUserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a single question and block until they answer. Use to resolve a decision that materially " +
      "affects architecture, implementation, behavior, or scope and that cannot be determined by inspecting the " +
      "codebase. Explore the codebase first; only ask when the code cannot answer. Ask one question at a time. " +
      "Provide a recommended option when you have enough information to make one. " +
      RESULT_JSON_DOC,
    promptSnippet: "Ask the user a structured question and wait for their answer",
    promptGuidelines: [
      "Use ask_user to resolve one important design decision at a time, only after codebase inspection cannot answer it.",
      "Inspect the repository before calling ask_user; do not ask questions the code already answers.",
      "Mark exactly one option with recommended:true and explain why in its description when you can recommend one.",
      "Ask one decision at a time; incorporate the answer before asking the next question.",
    ],
    parameters: AskUserParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await askUser(params, ctx);

      pi.appendEntry("planning-decision", {
        id: params.id,
        question: params.question,
        result,
        source: "user",
        ts: Date.now(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { result, question: params.question } as AskUserDetails,
        terminate: result.kind === "chat",
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question);
      const opts = Array.isArray(args.options) ? args.options : [];
      if (opts.length) {
        const labels = opts.map((o: { label: string; recommended?: boolean }, i: number) =>
          `${i + 1}. ${o.label}${o.recommended ? " ★" : ""}`,
        );
        text += `\n${theme.fg("dim", `  ${labels.join("   ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const d = result.details as AskUserDetails | undefined;
      const r = d?.result;
      if (!r) {
        const c = result.content[0];
        return new Text(c?.type === "text" ? c.text : "", 0, 0);
      }
      switch (r.kind) {
        case "answer":
          return new Text(theme.fg("success", "✓ ") + theme.fg("accent", r.selected.join(", ")), 0, 0);
        case "other":
          return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", r.customInput), 0, 0);
        case "chat":
          return new Text(theme.fg("warning", "↩ chat (free-form follow-up)"), 0, 0);
        case "cancelled":
          return new Text(theme.fg("warning", "cancelled"), 0, 0);
        case "unavailable":
          return new Text(theme.fg("warning", "no UI — proceed with recommended"), 0, 0);
      }
    },
  });
}
