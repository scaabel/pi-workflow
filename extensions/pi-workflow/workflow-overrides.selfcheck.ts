/**
 * Dependency-free self-check for machine-local workflow overrides.
 * Run with: bun extensions/pi-workflow/workflow-overrides.selfcheck.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOverrides, mergeOverrides, persistOverrides } from "./workflow-overrides";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-"));
  const file = path.join(dir, "workflow-overrides.json");

  try {
    // Missing file -> undefined (caller falls back to defaults).
    assert(loadOverrides(file) === undefined, "missing file -> undefined");

    // Round-trip: per-role model + thinking level, and the `null` override.
    const models = {
      planner: { provider: "opencode-go", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
      reviewer: null,
    };
    persistOverrides(file, models);
    const loaded = loadOverrides(file);
    assert(
      JSON.stringify(loaded) === JSON.stringify(models),
      "round-trip preserves model + thinkingLevel + null",
    );

    // Merge: persisted wins over defaults; untouched defaults survive; null overrides.
    const defaults = {
      planner: { provider: "d", modelId: "p" },
      scout: { provider: "d", modelId: "s" },
      reviewer: { provider: "d", modelId: "r" },
    };
    const merged = mergeOverrides(defaults, loaded!);
    assert(merged.planner?.thinkingLevel === "high", "merge: persisted planner wins");
    assert(merged.scout?.modelId === "s", "merge: untouched default preserved");
    assert(merged.reviewer === null, "merge: null overrides default");

    // Wrong schema version is ignored.
    fs.writeFileSync(file, JSON.stringify({ version: 2, models }), "utf-8");
    assert(loadOverrides(file) === undefined, "bad version -> undefined");

    console.log("workflow-overrides selfcheck: all passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
