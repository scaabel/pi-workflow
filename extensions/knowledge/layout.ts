/**
 * Knowledge repo layout: repo-relative paths, stable-ID construction, and a
 * path-traversal guard. Pure `node:path` + string ops, no pi imports.
 */

import * as path from "node:path";

export const LEARNING_CATEGORIES = ["concepts", "patterns", "debugging", "architecture", "tools"] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

/** `concepts`→`concept`, `patterns`→`pattern`, etc. */
export const TYPE_BY_CATEGORY: Record<LearningCategory, string> = {
  concepts: "concept",
  patterns: "pattern",
  debugging: "debugging",
  architecture: "architecture",
  tools: "tool",
};

/** Coerce an arbitrary category string to a valid one; defaults to `concepts`. */
export function normalizeCategory(category: string): LearningCategory {
  return (LEARNING_CATEGORIES as readonly string[]).includes(category)
    ? (category as LearningCategory)
    : "concepts";
}

export function sanitizeSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "unnamed"
  );
}

export function humanize(text: string): string {
  return text
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- repo-relative paths ---------------- */

export function conceptPath(category: LearningCategory, slug: string): string {
  return path.join("learning", category, `${sanitizeSlug(slug)}.md`);
}

export function featureDir(project: string, feature: string): string {
  return path.join("projects", sanitizeSlug(project), "features", sanitizeSlug(feature));
}

export function featurePath(project: string, feature: string): string {
  return path.join(featureDir(project, feature), "feature.md");
}

export function projectReadmePath(project: string): string {
  return path.join("projects", sanitizeSlug(project), "README.md");
}

export function decisionPath(slug: string): string {
  return path.join("decisions", `${sanitizeSlug(slug)}.md`);
}

export function planPath(status: "active" | "completed" | "abandoned", date: string, slug: string): string {
  return path.join("plans", status, `${date}-${sanitizeSlug(slug)}.md`);
}

/* ---------------- stable IDs ---------------- */

export function idFor(type: string, ...parts: string[]): string {
  return [type, ...parts.map((p) => sanitizeSlug(p))].join(".");
}

export function conceptId(slug: string): string {
  return idFor("concept", slug);
}

export function patternId(slug: string): string {
  return idFor("pattern", slug);
}

export function featureId(project: string, feature: string): string {
  return idFor("feature", project, feature);
}

export function projectId(project: string): string {
  return idFor("project", project);
}

export function planId(date: string, slug: string): string {
  return `plan.${date}.${sanitizeSlug(slug)}`;
}

export function decisionId(slug: string): string {
  return idFor("decision", slug);
}

/* ---------------- safety ---------------- */

export function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  if (path.isAbsolute(rel)) return false;
  const normalized = path.normalize(rel);
  if (normalized === ".." || normalized.startsWith(".." + path.sep)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

export function joinSafe(dir: string, rel: string): string {
  if (!isSafeRelPath(rel)) throw new Error(`Unsafe path: ${rel}`);
  return path.join(dir, rel);
}
