/**
 * Full-text search over the knowledge repo's Markdown corpus.
 *
 * // ponytail: naive fs walk + case-insensitive substring scan is fine for a
 * // personal KB (a few hundred small files). Swap in `rg -n --smart-case`
 * // (or a SQLite FTS index) when the corpus grows and this measurably lags.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { walkMarkdownFiles } from "./graph.js";

export interface SearchHit {
  relPath: string;
  line: number;
  snippet: string;
}

export async function search(dir: string, query: string, maxHits = 50): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  const files = await walkMarkdownFiles(dir);

  for (const abs of files) {
    let content = "";
    try {
      content = await fs.promises.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.toLowerCase().includes(q)) continue;
      hits.push({
        relPath: path.relative(dir, abs).split(path.sep).join("/"),
        line: i + 1,
        snippet: line.trim().slice(0, 160),
      });
      if (hits.length >= maxHits) return hits;
    }
  }

  return hits;
}
