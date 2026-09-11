/**
 * Persistence for the learning layer.
 *
 * State lives in ~/.pi/learning/ — global, cross-session, cross-project.
 * Obsidian notes are a separate, human-owned mirror (see obsidian.ts).
 *
 * All writes go through withFileMutationQueue; all reads validate and fall
 * back to fresh state on a bad file (never throw).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
  createInitialState,
  type Concept,
  type LearningSession,
  type LearningState,
  type QueueItem,
} from "./state.js";

/** ~/.pi/learning/ */
export const learningDir = path.resolve(getAgentDir(), "..", "learning");

function conceptsPath(): string {
  return path.join(learningDir, "concepts.json");
}

function reviewsPath(): string {
  return path.join(learningDir, "reviews.json");
}

function settingsPath(): string {
  return path.join(learningDir, "settings.json");
}

function queuePath(): string {
  return path.join(learningDir, "queue.json");
}

function sessionsDir(): string {
  return path.join(learningDir, "sessions");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await withFileMutationQueue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
  });
}

/** Load full state from disk. Never throws. */
export function loadState(): LearningState {
  const state = createInitialState();
  state.concepts = readJson<Record<string, Concept>>(conceptsPath(), {});
  state.reviews = readJson(reviewsPath(), []);
  state.queue = readJson<QueueItem[]>(queuePath(), []);
  state.settings = readJson(settingsPath(), {});
  return state;
}

/** Persist full state to disk. */
export async function saveState(state: LearningState): Promise<void> {
  await Promise.all([
    writeJson(conceptsPath(), state.concepts),
    writeJson(reviewsPath(), state.reviews),
    writeJson(queuePath(), state.queue),
    writeJson(settingsPath(), state.settings),
  ]);
}

export async function saveSession(session: LearningSession): Promise<void> {
  const file = path.join(sessionsDir(), `${session.id}.json`);
  await writeJson(file, session);
}

/** Slugify a topic for use as a stable concept id. */
export function slugifyTopic(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim()
      .slice(0, 64) || "concept"
  );
}

export function getConcept(state: LearningState, id: string): Concept | undefined {
  return state.concepts[id];
}

/**
 * Create a concept if absent, or return the existing one.
 * New concepts start `discovered` with zero mastery; callers bump to
 * `learning` when a session actually starts.
 */
export function upsertConcept(
  state: LearningState,
  name: string,
): Concept {
  const id = slugifyTopic(name);
  const existing = state.concepts[id];
  if (existing) return existing;

  const concept: Concept = {
    id,
    name,
    status: "discovered",
    mastery: 0,
    confidence: 0,
    misconceptions: [],
    sourcePlans: [],
    related: [],
  };
  state.concepts[id] = concept;
  return concept;
}

/** Add a topic to the queue, de-duplicated by topic name. */
export function enqueue(state: LearningState, item: QueueItem): void {
  const already = state.queue.some((q) => q.topic === item.topic);
  if (!already) state.queue.push(item);
}

/**
 * Simple interval schedule for review spacing.
 *
 * ponytail: fixed ladder instead of ts-fsrs. Upgrade to ts-fsrs
 * (open-spaced-repetition/ts-fsrs) when the workflow proves useful and
 * per-card stability/retrievability tuning actually matters.
 */
const REVIEW_INTERVALS_MS = [
  10 * 60 * 1000, // 10m
  24 * 60 * 60 * 1000, // 1d
  4 * 24 * 60 * 60 * 1000, // 4d
  10 * 24 * 60 * 60 * 1000, // 10d
  30 * 24 * 60 * 60 * 1000, // 30d
  90 * 24 * 60 * 60 * 1000, // 90d
];

export function nextReviewAt(reviewCount: number): string {
  const idx = Math.min(reviewCount, REVIEW_INTERVALS_MS.length - 1);
  return new Date(Date.now() + REVIEW_INTERVALS_MS[idx]).toISOString();
}

/** Concepts due for review (nextReview in the past, or lowest mastery fallback). */
export function pickDueConcept(state: LearningState): Concept | undefined {
  const candidates = Object.values(state.concepts).filter(
    (c) => c.status === "learned" || c.status === "reviewing",
  );

  if (candidates.length === 0) return undefined;

  const now = Date.now();
  const due = candidates
    .filter((c) => c.nextReview && Date.parse(c.nextReview) <= now)
    .sort((a, b) => Date.parse(a.nextReview!) - Date.parse(b.nextReview!));

  if (due.length > 0) return due[0];

  // Nothing due: lowest mastery first.
  return candidates.sort((a, b) => a.mastery - b.mastery)[0];
}
