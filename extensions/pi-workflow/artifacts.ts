/**
 * Artifact store for plan files.
 *
 * Plans are stored in <cwd>/.pi/plans/<slug>/plan.md
 * with a companion state.json for metadata.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { ActivePlan, PlanStatus } from "./state.js";

const ARTIFACT_ROOT_DIR = ".pi";
const PLANS_DIR = "plans";

/**
 * Get the artifact root directory for a given cwd.
 */
export function getArtifactRoot(cwd: string): string {
  return path.join(cwd, ARTIFACT_ROOT_DIR, PLANS_DIR);
}

/**
 * Slugify a string for use in file paths.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 64) || "plan";
}

/**
 * Check if a resolved path is inside the artifact root.
 */
export function isInsideArtifactRoot(cwd: string, targetPath: string): boolean {
  const artifactRoot = getArtifactRoot(cwd);
  
  // Resolve the target path (handle relative paths)
  const resolved = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath);
  
  // Get real paths to handle symlinks
  try {
    const realRoot = fs.realpathSync(artifactRoot);
    const realResolved = fs.realpathSync(resolved);
    return realResolved.startsWith(realRoot + path.sep) || realResolved === realRoot;
  } catch {
    // If realpath fails, fall back to string comparison
    return resolved.startsWith(artifactRoot + path.sep) || resolved === artifactRoot;
  }
}

interface PlanArtifactFrontmatter {
  id: string;
  slug: string;
  status: PlanStatus;
  request: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanArtifactState {
  id: string;
  slug: string;
  status: PlanStatus;
  request: string;
  createdAt: string;
  updatedAt: string;
  steps?: Array<{ id: string; description: string; status: "pending" | "in_progress" | "completed" }>;
}

/**
 * Create a new plan artifact.
 */
export async function createPlanArtifact(
  cwd: string,
  slug: string,
  request: string,
): Promise<{ artifactPath: string; statePath: string }> {
  const root = getArtifactRoot(cwd);
  const planDir = path.join(root, slug);
  const artifactPath = path.join(planDir, "plan.md");
  const statePath = path.join(planDir, "state.json");
  
  const id = `plan_${Date.now()}_${slug.slice(0, 8)}`;
  const now = new Date().toISOString();
  
  const frontmatter = [
    "---",
    `id: ${id}`,
    `slug: ${slug}`,
    "status: planning",
    `request: ${JSON.stringify(request)}`,
    `createdAt: ${now}`,
    `updatedAt: ${now}`,
    "---",
    "",
  ].join("\n");
  
  const initialContent = frontmatter + "# " + slug.replace(/-/g, " ").toUpperCase() + "\n\n";
  
  const state: PlanArtifactState = {
    id,
    slug,
    status: "planning",
    request,
    createdAt: now,
    updatedAt: now,
  };
  
  await withFileMutationQueue(artifactPath, async () => {
    await fs.promises.mkdir(planDir, { recursive: true });
    await fs.promises.writeFile(artifactPath, initialContent, "utf-8");
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  });
  
  return { artifactPath, statePath };
}

/**
 * Read a plan artifact from disk.
 */
export async function readPlanArtifact(artifactPath: string): Promise<string> {
  return fs.promises.readFile(artifactPath, "utf-8");
}

/**
 * Update the plan artifact state.
 */
export async function updateArtifactState(
  statePath: string,
  updates: Partial<PlanArtifactState>,
): Promise<void> {
  await withFileMutationQueue(statePath, async () => {
    const existing = JSON.parse(await fs.promises.readFile(statePath, "utf-8")) as PlanArtifactState;
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    await fs.promises.writeFile(statePath, JSON.stringify(updated, null, 2), "utf-8");
  });
}

/**
 * Read the artifact state.
 */
export async function readArtifactState(statePath: string): Promise<PlanArtifactState> {
  const content = await fs.promises.readFile(statePath, "utf-8");
  return JSON.parse(content) as PlanArtifactState;
}

/**
 * Extract plan text from artifact (strip frontmatter).
 */
export function extractPlanText(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Parse frontmatter from artifact content.
 */
export function parseFrontmatter(content: string): PlanArtifactFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key && valueParts.length > 0) {
      const value = valueParts.join(":").trim().replace(/^"|"$/g, "");
      frontmatter[key.trim()] = value;
    }
  }
  
  return {
    id: frontmatter.id || "",
    slug: frontmatter.slug || "",
    status: (frontmatter.status as PlanStatus) || "planning",
    request: frontmatter.request || "",
    createdAt: frontmatter.createdAt || "",
    updatedAt: frontmatter.updatedAt || "",
  };
}
