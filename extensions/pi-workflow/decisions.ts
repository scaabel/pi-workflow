/**
 * Decision ledger reader.
 *
 * The ask_user tool records each answered question as a
 * `planning-decision` custom entry. pi-workflow reads them back here for
 * /replan (re-validating an existing plan's decisions).
 *
 * The entry shape is defined structurally so this module does not depend on
 * the ask-user extension's source.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DecisionSource = "user" | "codebase" | "agent";

/** Structural mirror of the ask_user result union (kind + payload). */
export interface DecisionResult {
  kind: "answer" | "other" | "chat" | "cancelled" | "unavailable" | string;
  selected?: string[];
  customInput?: string;
  recommended?: string;
}

export interface PlanningDecision {
  id: string;
  question: string;
  result: DecisionResult;
  source: DecisionSource;
  ts: number;
}

export const DECISION_ENTRY_TYPE = "planning-decision";

/** Read every recorded decision from the session, oldest first. */
export function readDecisions(ctx: ExtensionContext): PlanningDecision[] {
  const out: PlanningDecision[] = [];

  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as { type?: string; customType?: string; data?: unknown };
    if (e.type === "custom" && e.customType === DECISION_ENTRY_TYPE) {
      out.push(e.data as PlanningDecision);
    }
  }

  return out;
}

/** Human/LLM-readable summary of the recorded decisions. */
export function renderDecisionsSummary(decisions: PlanningDecision[]): string {
  if (decisions.length === 0) return "(none)";

  return decisions
    .map((d) => {
      const r = d.result ?? { kind: "" };
      let answer: string;

      switch (r.kind) {
        case "answer":
          answer = (r.selected ?? []).join(", ");
          break;
        case "other":
          answer = `(wrote) ${r.customInput ?? ""}`;
          break;
        case "chat":
          answer = "deferred to chat";
          break;
        case "cancelled":
          answer = "(cancelled)";
          break;
        case "unavailable":
          answer = `(no UI; recommended: ${r.recommended ?? "none"})`;
          break;
        default:
          answer = "";
      }

      return `- ${d.id} [source: ${d.source}]\n    Q: ${d.question}\n    A: ${answer}`;
    })
    .join("\n");
}
