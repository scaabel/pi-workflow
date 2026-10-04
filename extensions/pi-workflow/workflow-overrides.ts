/**
 * Machine-local, cross-session workflow role-model overrides.
 *
 * Dependency-free (node:fs only) so it can be unit-tested standalone; `index.ts`
 * supplies the file path (`~/.pi/agent/workflow-overrides.json`). Reloading a
 * session merges these over the built-in defaults so `/workflow-models` choices
 * survive new sessions and tmux sessions.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { ModelRef, WorkflowRole } from "./state.js";

export type Overrides = Partial<Record<WorkflowRole, ModelRef | null>>;

/** Read persisted overrides, or `undefined` when missing/invalid. */
export function loadOverrides(file: string): Overrides | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf-8"));
    return d?.version === 1 && d.models ? (d.models as Overrides) : undefined;
  } catch {
    return undefined;
  }
}

/** Write overrides to disk. Best-effort: never throws into the session. */
export function persistOverrides(file: string, models: Overrides): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, models }, null, 2),
      "utf-8",
    );
  } catch {
    // Persistence is best-effort; never break the session over it.
  }
}

/** Persisted overrides win over defaults; `null` still overrides the default. */
export function mergeOverrides(
  defaults: Partial<Record<WorkflowRole, ModelRef>>,
  persisted: Overrides,
): Overrides {
  return { ...defaults, ...persisted };
}
