/**
 * Self-check for the omp-style "continue with" execute-model selector.
 *
 * Run with:
 *   bun extensions/pi-workflow/plan-selector.selfcheck.ts
 *
 * Needs `@earendil-works/pi-coding-agent` (and its pi-tui/pi-ai/typebox peers)
 * resolvable. If not in local node_modules, run:
 *   NODE_PATH="$(npm root -g)" bun extensions/pi-workflow/plan-selector.selfcheck.ts
 */
import { buildExecuteModelOptions, createExecuteSelector } from "./plan-mode.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

function state(models: Record<string, unknown>) {
  return { version: 1, models } as never;
}

function main() {
  // Executor first, distinct models only, null overrides skipped.
  const multi = state({
    executor: { provider: "p", modelId: "e" },
    planner: { provider: "p", modelId: "e" }, // duplicate -> deduped
    scout: { provider: "p", modelId: "s" },
    reviewer: null, // "use current Pi model" -> skipped
  });

  const opts = buildExecuteModelOptions(multi);
  assert(opts.length === 2, `deduped to 2 (got ${opts.length})`);
  assert(opts[0]!.value === "executor", "executor first");
  assert(opts[1]!.value === "scout", "scout second");
  assert(opts[0]!.label.includes("executor · p/e"), "label is '<role> · provider/model'");

  // Fewer than 2 distinct -> selector hidden, defaults to executor.
  const single = state({ executor: { provider: "p", modelId: "e" } });
  const hidden = createExecuteSelector(single);
  assert(hidden.modelOptions === undefined, "hidden when <2 distinct");
  assert(hidden.role === "executor", "defaults to executor when hidden");

  // Two or more -> visible, starts on executor, cycling updates the role.
  const shown = createExecuteSelector(multi);
  assert(shown.modelOptions?.length === 2, "visible when >=2 distinct");
  assert(shown.initialModelIndex === 0, "starts on executor");
  assert(shown.role === "executor", "initial role is executor");
  shown.onModelChange("scout");
  assert(shown.role === "scout", "onModelChange updates the selected role");

  console.log("plan selector selfcheck: all passed");
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
