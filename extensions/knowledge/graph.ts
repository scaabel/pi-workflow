/**
 * The knowledge graph: scan Markdown frontmatter into an id→artifact map and
 * maintain directional relationships. This is the one scanner that feeds
 * link / read / check / index — the relationship graph is derived, never
 * stored in a database.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getMeta, setRelationships, type Relationship } from "./frontmatter.js";
import { isSafeRelPath, joinSafe } from "./layout.js";

export interface Artifact {
  id: string;
  type: string;
  /** Repo-relative path, `/`-separated. */
  path: string;
  title?: string;
  relationships: Relationship[];
}

export interface ScanResult {
  dir: string;
  artifacts: Map<string, Artifact>;
  errors: string[];
}

/** Recursively list `*.md` files, skipping dotdirs, node_modules, and `_index/`. */
export async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "_index") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  await rec(dir);
  return out;
}

export async function scan(dir: string): Promise<ScanResult> {
  const artifacts = new Map<string, Artifact>();
  const errors: string[] = [];
  const files = await walkMarkdownFiles(dir);

  for (const abs of files) {
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    let content = "";
    try {
      content = await fs.promises.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const meta = getMeta(content);
    if (!meta.id) continue; // non-artifact docs (README, index) are not graph nodes
    const art: Artifact = {
      id: meta.id,
      type: meta.type ?? "unknown",
      path: rel,
      title: meta.title,
      relationships: meta.relationships ?? [],
    };
    if (artifacts.has(art.id)) {
      errors.push(`duplicate id "${art.id}" (${artifacts.get(art.id)!.path} and ${rel})`);
    } else {
      artifacts.set(art.id, art);
    }
  }

  return { dir, artifacts, errors };
}

export const INVERSE: Record<string, string> = {
  contains: "contained-in",
  "contained-in": "contains",
  implements: "implemented-by",
  "implemented-by": "implements",
  uses: "demonstrated-by",
  produces: "demonstrated-by",
  "demonstrated-by": "uses",
  records: "recorded-by",
  "recorded-by": "records",
};

export function inverseOf(type: string): string | undefined {
  return INVERSE[type];
}

async function addRelationship(dir: string, relPath: string, type: string, target: string): Promise<void> {
  const abs = joinSafe(dir, relPath);
  const content = await fs.promises.readFile(abs, "utf-8");
  const meta = getMeta(content);
  const rels = meta.relationships ?? [];
  if (rels.some((r) => r.type === type && r.target === target)) return;
  rels.push({ type, target });
  await fs.promises.writeFile(abs, setRelationships(content, rels), "utf-8");
}

/**
 * Link `from` → `to` (forward `type`) and auto-write the inverse on `to`.
 * Both sides are maintained here so the LLM never has to remember to update
 * N files.
 */
export async function relate(
  scanResult: ScanResult,
  fromId: string,
  toId: string,
  type: string,
): Promise<void> {
  const from = scanResult.artifacts.get(fromId);
  const to = scanResult.artifacts.get(toId);
  if (!from) throw new Error(`unknown id: ${fromId}`);
  if (!to) throw new Error(`unknown id: ${toId}`);

  await addRelationship(scanResult.dir, from.path, type, toId);
  const inv = inverseOf(type);
  if (inv) {
    await addRelationship(scanResult.dir, to.path, inv, fromId);
  }
}

export function resolveId(scanResult: ScanResult, id: string): Artifact | undefined {
  return scanResult.artifacts.get(id);
}

export interface UsedInEntry {
  id: string;
  type: string;
  title?: string;
  relType: string;
}

/** Reverse lookup: every artifact that references `id`. */
export function usedIn(scanResult: ScanResult, id: string): UsedInEntry[] {
  const out: UsedInEntry[] = [];
  for (const art of scanResult.artifacts.values()) {
    for (const r of art.relationships) {
      if (r.target === id) out.push({ id: art.id, type: art.type, title: art.title, relType: r.type });
    }
  }
  return out;
}
