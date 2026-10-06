/**
 * Self-check for the /plans registry: creation-time records + approval upsert.
 * Run with: bun extensions/pi-workflow/plan-registry.selfcheck.ts
 */
import { createPlansModule } from "./plans";
import type { WorkflowState } from "./state";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

function makeState(): WorkflowState {
  return { version: 1, models: {}, plans: [], nextPlanId: undefined };
}

function makeModule(state: WorkflowState) {
  const module = createPlansModule({ registerCommand() {} } as any, {
    getState: () => state,
    save: () => {},
    getPlanMode: () => ({ enable() {}, disable() {}, isEnabled: () => false }),
  });
  return module;
}

function activePlan(slug: string, artifactPath: string) {
  return {
    id: `plan_${slug}`,
    slug,
    artifactPath,
    status: "planning" as const,
    request: slug,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function main() {
  // 1. recordPlanning appends a "planning" record.
  {
    const state = makeState();
    const module = makeModule(state);
    module.recordPlanning({ slug: "p1", artifactPath: "/tmp/p1/plan.md", title: "First task" });
    assert(state.plans?.length === 1, "recordPlanning appends one");
    assert(state.plans?.[0].status === "planning", "status is planning");
    assert(state.plans?.[0].dispatched === false, "not dispatched");
    assert(state.plans?.[0].title === "First task", "provisional title kept");
    assert(state.nextPlanId === 2, "nextPlanId advanced to 2");
  }

  // 2. recordPlanning dedups by slug.
  {
    const state = makeState();
    const module = makeModule(state);
    module.recordPlanning({ slug: "p1", artifactPath: "/tmp/p1/plan.md", title: "First task" });
    module.recordPlanning({ slug: "p1", artifactPath: "/tmp/p1/plan.md", title: "First task" });
    assert(state.plans?.length === 1, "same slug does not duplicate");
  }

  // 3. Approval promotes the planning record in place (no duplicate) + refines title.
  {
    const state = makeState();
    const module = makeModule(state);
    module.recordPlanning({ slug: "p1", artifactPath: "/tmp/p1/plan.md", title: "First task" });
    state.activePlan = activePlan("p1", "/tmp/p1/plan.md");
    module.recordApproval("# Cool Plan\n\nsteps", "/tmp/p1/plan.md");
    assert(state.plans?.length === 1, "approval does not duplicate");
    assert(state.plans?.[0].status === "active", "promoted to active");
    assert(state.plans?.[0].dispatched === true, "marked dispatched");
    assert(state.plans?.[0].title === "Cool Plan", "title refined from plan text");
  }

  // 4. Approval with no prior record falls back to creating one (legacy flow).
  {
    const state = makeState();
    const module = makeModule(state);
    state.activePlan = activePlan("legacy", "/tmp/legacy/plan.md");
    module.recordApproval("# Legacy Plan", "/tmp/legacy/plan.md");
    assert(state.plans?.length === 1, "fallback creates a record");
    assert(state.plans?.[0].status === "active", "fallback is active");
    assert(state.plans?.[0].slug === "legacy", "fallback keeps slug");
  }

  // 5. Approving a new plan demotes the prior active one.
  {
    const state = makeState();
    const module = makeModule(state);
    module.recordPlanning({ slug: "old", artifactPath: "/tmp/old/plan.md", title: "Old" });
    state.activePlan = activePlan("old", "/tmp/old/plan.md");
    module.recordApproval("# Old Plan", "/tmp/old/plan.md");

    module.recordPlanning({ slug: "new", artifactPath: "/tmp/new/plan.md", title: "New" });
    state.activePlan = activePlan("new", "/tmp/new/plan.md");
    module.recordApproval("# New Plan", "/tmp/new/plan.md");

    const old = state.plans?.find((p) => p.slug === "old");
    const fresh = state.plans?.find((p) => p.slug === "new");
    assert(old?.status === "partial", "prior active demoted to partial");
    assert(fresh?.status === "active", "new plan active");
    assert(state.plans?.length === 2, "two distinct plans");
  }

  console.log("plan-registry selfcheck: all passed");
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
