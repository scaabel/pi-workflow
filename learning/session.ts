/**
 * Explicit learning-session state machine (§6).
 *
 * The tutor LLM is free to converse, but phase transitions are gated here so
 * a misbehaving tutor can't skip retrieval or jump straight to scheduling.
 */

import type { LearningPhase, LearningSession } from "./state.js";

export const PHASES: LearningPhase[] = [
  "discover",
  "retrieve",
  "assess",
  "explain",
  "practice",
  "retrieve_again",
  "assess2",
  "schedule",
];

const ORDER = new Map<LearningPhase, number>(
  PHASES.map((phase, i) => [phase, i]),
);

export function isTerminal(phase: LearningPhase): boolean {
  return phase === "schedule";
}

export function nextPhase(phase: LearningPhase): LearningPhase | undefined {
  const idx = ORDER.get(phase);
  return idx === undefined ? undefined : PHASES[idx + 1];
}

export interface AdvanceResult {
  ok: boolean;
  reason?: string;
}

/**
 * Forward-only transition check. A phase may re-enter its current phase
 * (re-attempt) but never move backward or skip ahead.
 */
export function canAdvance(
  session: LearningSession,
  phase: LearningPhase,
): AdvanceResult {
  const idx = ORDER.get(phase);
  if (idx === undefined) {
    return { ok: false, reason: `unknown phase "${phase}"` };
  }

  const last = session.phases[session.phases.length - 1]?.phase;
  const lastIdx = last === undefined ? -1 : (ORDER.get(last) ?? -1);

  if (idx < lastIdx) {
    return {
      ok: false,
      reason: `out-of-order: already passed "${phase}" (current: ${last ?? "none"})`,
    };
  }

  if (idx > lastIdx + 1) {
    return {
      ok: false,
      reason: `skipped ahead: expected "${PHASES[lastIdx + 1]}" next, got "${phase}"`,
    };
  }

  return { ok: true };
}

export function advance(session: LearningSession, phase: LearningPhase): AdvanceResult {
  const result = canAdvance(session, phase);
  if (!result.ok) return result;

  if (session.phases[session.phases.length - 1]?.phase !== phase) {
    session.phases.push({ phase, at: new Date().toISOString() });
  }

  return { ok: true };
}

export function createSession(topicId: string): LearningSession {
  return {
    id: `learn_${Date.now()}_${topicId.slice(0, 8)}`,
    topicId,
    startedAt: new Date().toISOString(),
    phases: [],
    answers: [],
    misconceptionsFound: [],
  };
}
