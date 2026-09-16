/**
 * Deterministic knowledge-graph validator ("knowledge doctor").
 *
 * LLMs generate content; this code verifies structure. Every check is a pure
 * function of the scan + filesystem, so it can never drift with the model.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { inverseOf, usedIn, type ScanResult } from "./graph.js";

const GLOBAL_TYPES = new Set(["concept", "pattern", "architecture", "debugging", "tool"]);

export interface CheckReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { artifacts: number; relationships: number; links: number };
}

export async function check(scanResult: ScanResult): Promise<CheckReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let relationships = 0;
  let links = 0;

  for (const art of scanResult.artifacts.values()) {
    // Schema
    if (!art.id.includes(".")) errors.push(`${art.path}: id "${art.id}" has no type prefix`);
    if (!art.type || art.type === "unknown") errors.push(`${art.path}: missing "type" frontmatter`);
    const prefix = art.id.split(".")[0] ?? "";
    if (art.type && art.type !== "unknown" && prefix && prefix !== art.type) {
      errors.push(`${art.path}: id prefix "${prefix}" != type "${art.type}"`);
    }

    // References + inverse consistency
    relationships += art.relationships.length;
    for (const r of art.relationships) {
      if (!r.type || !r.target) {
        errors.push(`${art.path}: relationship missing type or target`);
        continue;
      }
      if (!scanResult.artifacts.has(r.target)) {
        errors.push(`${art.path}: broken reference → ${r.target}`);
        continue;
      }
      const inv = inverseOf(r.type);
      if (inv) {
        const target = scanResult.artifacts.get(r.target)!;
        if (!target.relationships.some((t) => t.type === inv && t.target === art.id)) {
          errors.push(`${art.path}: missing inverse — ${r.target} should have "${inv}" → ${art.id}`);
        }
      }
    }

    // Markdown links (relative, non-anchor, non-http)
    const abs = path.join(scanResult.dir, art.path);
    let content = "";
    try {
      content = await fs.promises.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const linkRe = /\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(content)) !== null) {
      const target = (m[1] ?? "").trim();
      if (!target) continue;
      if (/^(https?:\/\/|mailto:|#)/.test(target)) continue;
      const filePart = target.split("#")[0] ?? "";
      if (!filePart) continue;
      links++;
      const resolved = path.resolve(path.dirname(abs), filePart);
      if (!fs.existsSync(resolved)) {
        errors.push(`${art.path}: broken markdown link → ${target}`);
      }
    }
  }

  // Orphans / quality warnings (not failures)
  for (const art of scanResult.artifacts.values()) {
    if (GLOBAL_TYPES.has(art.type)) {
      const demonstrated = usedIn(scanResult, art.id).filter((u) => u.relType === "uses" || u.relType === "produces");
      if (demonstrated.length === 0) {
        warnings.push(`${art.id}: no feature demonstrates this (orphaned ${art.type})`);
      }
    }
    if (art.type === "feature") {
      const out = art.relationships.filter((r) => r.type === "uses" || r.type === "produces");
      if (out.length === 0) warnings.push(`${art.id}: feature has no linked concepts`);

      const learningsAbs = path.join(path.dirname(path.join(scanResult.dir, art.path)), "learnings.md");
      try {
        const txt = await fs.promises.readFile(learningsAbs, "utf-8");
        const body = txt.split(/^---[\s\S]*?---/m).pop() ?? txt;
        if (body.trim().length <= "# Learnings".length + 8) {
          warnings.push(`${art.id}: feature has no learnings yet`);
        }
      } catch {
        warnings.push(`${art.id}: feature has no learnings.md`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: { artifacts: scanResult.artifacts.size, relationships, links },
  };
}

export function renderReport(report: CheckReport): string {
  const c = report.counts;
  const refErrors = report.errors.filter((e) => e.includes("broken reference")).length;
  const relErrors = report.errors.filter((e) => e.includes("inverse")).length;
  const mdErrors = report.errors.filter((e) => e.includes("markdown link")).length;
  const schemaErrors = report.errors.length - refErrors - relErrors - mdErrors;

  const lines: string[] = [];
  lines.push("Knowledge Doctor");
  lines.push("────────────────");
  lines.push(`Schema       ${schemaErrors === 0 ? "✓" : "✗"} ${c.artifacts} artifacts, ${schemaErrors} invalid`);
  lines.push(`References   ${refErrors === 0 ? "✓" : "✗"} ${c.relationships} relationships, ${refErrors} broken`);
  lines.push(`Relationships ${relErrors === 0 ? "✓" : "✗"} ${relErrors} missing inverses`);
  lines.push(`Markdown     ${mdErrors === 0 ? "✓" : "✗"} ${c.links} links, ${mdErrors} broken`);

  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors) lines.push(`  ✗ ${e}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? report.warnings.length > 0
        ? "Result: PASS with warnings"
        : "Result: PASS"
      : `Result: FAIL (${report.errors.length} error${report.errors.length === 1 ? "" : "s"})`,
  );
  return lines.join("\n");
}
