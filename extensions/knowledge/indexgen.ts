/**
 * Generated indexes. Derived artifacts, not sources of truth — regenerate
 * with `/knowledge index` (and automatically before `/knowledge commit`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { usedIn, type ScanResult, type Artifact } from "./graph.js";
import { humanize } from "./layout.js";

function titleOf(art: Artifact): string {
  return art.title ?? humanize(art.id.split(".").slice(1).join(" ") || art.id);
}

function link(art: Artifact): string {
  return `[${titleOf(art)}](../${art.path})`;
}

function byType(scanResult: ScanResult, type: string): Artifact[] {
  return [...scanResult.artifacts.values()].filter((a) => a.type === type);
}

async function writeIndex(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, "_index", name);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, "utf-8");
  return file;
}

export async function generateIndexes(scanResult: ScanResult): Promise<string[]> {
  const globalTypes = ["concept", "pattern", "architecture", "debugging", "tool"];
  const written: string[] = [];

  // concepts.md — global knowledge + where it is demonstrated.
  {
    const lines = ["# Concepts", "", "> Generated. Do not edit — run `/knowledge index`."];
    for (const type of globalTypes) {
      const arts = byType(scanResult, type).sort((a, b) => a.id.localeCompare(b.id));
      if (arts.length === 0) continue;
      lines.push("", `## ${type[0]!.toUpperCase() + type.slice(1)}`);
      for (const art of arts) {
        const demonstrated = usedIn(scanResult, art.id).filter((u) => u.relType === "uses" || u.relType === "produces");
        const where = demonstrated.length
          ? ` — ${demonstrated.map((d) => humanize(d.id)).join(", ")}`
          : "";
        lines.push(`- ${link(art)}${where}`);
      }
    }
    written.push(await writeIndex(scanResult.dir, "concepts.md", lines.join("\n") + "\n"));
  }

  // features.md — grouped by project.
  {
    const lines = ["# Features", "", "> Generated. Do not edit."];
    const features = byType(scanResult, "feature").sort((a, b) => a.id.localeCompare(b.id));
    const byProject = new Map<string, Artifact[]>();
    for (const f of features) {
      const project = f.id.split(".")[1] ?? "(no project)";
      (byProject.get(project) ?? byProject.set(project, []).get(project)!).push(f);
    }
    for (const [project, arts] of [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push("", `## ${humanize(project)}`);
      for (const art of arts) lines.push(`- ${link(art)}`);
    }
    written.push(await writeIndex(scanResult.dir, "features.md", lines.join("\n") + "\n"));
  }

  // projects.md
  {
    const lines = ["# Projects", "", "> Generated. Do not edit."];
    const projects = byType(scanResult, "project").sort((a, b) => a.id.localeCompare(b.id));
    for (const p of projects) {
      const contained = usedIn(scanResult, p.id).filter((u) => u.relType === "contained-in");
      lines.push(`- ${link(p)}${contained.length ? ` — ${contained.length} feature${contained.length === 1 ? "" : "s"}` : ""}`);
    }
    written.push(await writeIndex(scanResult.dir, "projects.md", lines.join("\n") + "\n"));
  }

  // relationships.md — full graph dump.
  {
    const lines = ["# Relationships", "", "> Generated. Do not edit."];
    for (const art of [...scanResult.artifacts.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (art.relationships.length === 0) continue;
      lines.push("", `## ${titleOf(art)} (\`${art.id}\`)`);
      for (const r of art.relationships) lines.push(`- ${r.type} → \`${r.target}\``);
    }
    written.push(await writeIndex(scanResult.dir, "relationships.md", lines.join("\n") + "\n"));
  }

  return written;
}
