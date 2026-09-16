/**
 * Dependency-free self-check for the knowledge graph.
 * Run with: bun extensions/knowledge/graph.selfcheck.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createKnowledgeAdapter } from "./adapter.js";
import { scan } from "./graph.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function main() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kb-"));
  const k = createKnowledgeAdapter(dir);

  // 1. Scaffold a mini graph.
  await k.scaffoldFeature("acme", "widgets");
  await k.createConcept("concepts", "gadgets", { title: "Gadgets" }, "## Mental Model\n\nWidgets use gadgets.\n");
  await k.create("plans/active/2026-01-01-widgets.md", [
    "---",
    "id: plan.2026-01-01.widgets",
    "type: plan",
    "---",
    "",
    "# Widgets plan",
    "",
  ].join("\n"));

  // 2. Link with inverses.
  await k.link("project.acme", "feature.acme.widgets", "contains");
  await k.link("plan.2026-01-01.widgets", "feature.acme.widgets", "implements");
  await k.link("feature.acme.widgets", "concept.gadgets", "uses");

  // 3. Assert both sides written.
  let s = await scan(dir);
  const feat = s.artifacts.get("feature.acme.widgets")!;
  const concept = s.artifacts.get("concept.gadgets")!;
  assert(feat.relationships.some((r) => r.type === "uses" && r.target === "concept.gadgets"), "feature has forward link");
  assert(concept.relationships.some((r) => r.type === "demonstrated-by" && r.target === "feature.acme.widgets"), "concept has inverse link");
  assert(s.artifacts.get("project.acme")!.relationships.some((r) => r.type === "contains"), "project contains feature");
  assert(s.artifacts.get("plan.2026-01-01.widgets")!.relationships.some((r) => r.type === "implements"), "plan implements feature");

  // 3b. Append a learning so the feature is not flagged as empty.
  const learnRel = await k.appendLearning("acme", "widgets", "Widgets taught me about gadgets.");
  const learnings = await k.read(learnRel);
  assert(learnings.includes("Widgets taught me"), "learning appended");

  // 4. Validator passes.
  const report = await k.check();
  assert(report.ok, "check passes on a consistent graph: " + report.errors.join("; "));
  assert(report.warnings.length === 0, "no warnings expected: " + report.warnings.join("; "));

  // 5. Reverse lookup.
  const used = await k.usedIn("concept.gadgets");
  assert(used.some((u) => u.id === "feature.acme.widgets" && u.relType === "uses"), "usedIn finds the feature");

  // 6. Indexes generated.
  const written = await k.index();
  assert(written.length === 4, "4 index files generated");
  assert(fs.existsSync(path.join(dir, "_index", "relationships.md")), "relationships index exists");

  // 7. (learning already appended above) — nothing further here.
  // 8. Orphan detection.
  await k.createConcept("patterns", "orphan-pattern", { title: "Orphan" }, "## Mental Model\n\nNothing here.\n");
  const report2 = await k.check();
  assert(report2.ok, "still passes with an orphan (orphan is a warning, not an error)");
  assert(report2.warnings.some((w) => w.includes("orphan-pattern") && w.includes("orphaned")), "orphan flagged");

  // 9. Broken reference FAILs.
  await k.create("learning/concepts/broken.md", [
    "---",
    "id: concept.broken",
    "type: concept",
    "relationships:",
    "  - type: demonstrated-by",
    "    target: feature.does.not.exist",
    "---",
    "",
    "# Broken",
    "",
  ].join("\n"));
  const report3 = await k.check();
  assert(!report3.ok, "broken reference fails the check");
  assert(report3.errors.some((e) => e.includes("broken reference")), "broken reference reported");
  await fs.promises.rm(path.join(dir, "learning", "concepts", "broken.md"));

  // 10. Traversal guard.
  let threw = false;
  try {
    await k.read("../etc/passwd");
  } catch {
    threw = true;
  }
  assert(threw, "path traversal rejected");

  // 11. publishPlan composes scaffold + durable plan + links.
  await k.publishPlan({
    slug: "gadget-v2",
    project: "acme",
    feature: "gadget-v2",
    planBody: "# Gadget v2\n\n## Goal\n\nShip it.\n",
  });
  const s3 = await scan(dir);
  assert(s3.artifacts.has("plan." + new Date().toISOString().slice(0, 10) + ".gadget-v2"), "durable plan artifact exists");
  assert(s3.artifacts.has("feature.acme.gadget-v2"), "published feature exists");
  const report4 = await k.check();
  assert(report4.ok, "publishPlan keeps the graph consistent: " + report4.errors.join("; "));

  console.log("knowledge graph selfcheck: all passed");
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
