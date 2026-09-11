/**
 * Pure types for the ask_user tool. No runtime imports so this module can be
 * consumed by the dependency-free self-check.
 */

export interface AskOption {
  /** Display label for the option. */
  label: string;
  /** Optional description shown below the label. */
  description?: string;
  /** Value returned when selected. Defaults to label. */
  value?: string;
  /** Mark exactly one option as the recommended answer. */
  recommended?: boolean;
}

export interface AskUserParams {
  /** Stable identifier for this decision, e.g. "recurrence-model". */
  id: string;
  /** The question to ask. */
  question: string;
  /** Options to choose from. Omit for a free-text answer. */
  options?: AskOption[];
  /** Allow selecting multiple options (default false). */
  multi?: boolean;
  /** Show an "Other…" free-text entry (default true). */
  allowOther?: boolean;
  /** Prefer a multiline editor for free text (default false). */
  multiline?: boolean;
}

export type AskUserResult =
  | { kind: "answer"; questionId: string; selected: string[]; customInput?: string }
  | { kind: "other"; questionId: string; customInput: string }
  | { kind: "chat"; questionId: string }
  | { kind: "cancelled"; questionId: string }
  | { kind: "unavailable"; questionId: string; recommended?: string };
