/**
 * Learning-layer state types + factory.
 *
 * This is the *human understanding* model — distinct from the agent's
 * session-scoped memory. It lives on disk under ~/.pi/learning/ and survives
 * sessions and projects.
 */

export type ConceptStatus =
  | "discovered"
  | "learning"
  | "learned"
  | "reviewing";

export type MisconceptionStatus = "open" | "corrected";

export interface Misconception {
  id: string;
  statement: string;
  correctModel: string;
  status: MisconceptionStatus;
  discoveredAt: string;
}

export interface Concept {
  id: string;
  name: string;
  status: ConceptStatus;
  /** 0..100 — how well the human can use this without Pi. */
  mastery: number;
  /** 0..100 — how confident the human is (self-reported). */
  confidence: number;
  lastReviewed?: string;
  nextReview?: string;
  misconceptions: Misconception[];
  sourcePlans: string[];
  related: string[];
}

export type LearningPhase =
  | "discover"
  | "retrieve"
  | "assess"
  | "explain"
  | "practice"
  | "retrieve_again"
  | "assess2"
  | "schedule";

export interface PhaseMark {
  phase: LearningPhase;
  at: string;
}

export interface Answer {
  phase: string;
  question: string;
  answer: string;
}

export interface LearningSession {
  id: string;
  topicId: string;
  startedAt: string;
  endedAt?: string;
  phases: PhaseMark[];
  answers: Answer[];
  misconceptionsFound: string[];
  masteryBefore?: number;
  masteryAfter?: number;
}

export type QueuePriority = "high" | "medium" | "low";

export interface QueueItem {
  topic: string;
  source: string;
  priority: QueuePriority;
  reason: string;
}

export interface ReviewRecord {
  topicId: string;
  reviewedAt: string;
  result: string;
  masteryAfter: number;
}

export interface LearningSettings {
  obsidianVaultPath?: string;
}

export interface LearningState {
  version: 1;
  concepts: Record<string, Concept>;
  queue: QueueItem[];
  reviews: ReviewRecord[];
  settings: LearningSettings;
}

export function createInitialState(): LearningState {
  return {
    version: 1,
    concepts: {},
    queue: [],
    reviews: [],
    settings: {},
  };
}
