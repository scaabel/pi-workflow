/**
 * Dependency-light self-check for on-disk plan listing + status persistence.
 *
 * Run with:
 *   bun extensions/pi-workflow/plans.selfcheck.ts
 *
 * Needs `@earendil-works/pi-coding-agent` resolvable (pi ships it). If it is
 * not in local node_modules, run:
 *   NODE_PATH="$(npm root -g)" bun extensions/pi-workflow/plans.selfcheck.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

function frontmatter(o: Record<string, string>): string {
  return [
    "---",
    ...Object.entries(o).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    `# ${o.slug}`,
    "",
  ].join("\n");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-"));

  // getAgentDir() honors PI_CODING_AGENT_DIR; artifact root resolves to
  // <root>/plans/<project-slug>.
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

  const { listPlanArtifacts, setArtifactStatus } = await import("./artifacts.ts");

  const projectDir = path.join(root, "proj");
  const artifactRoot = path.join(root, "plans", "proj");

  const alphaDir = path.join(artifactRoot, "alpha");
  const betaDir = path.join(artifactRoot, "beta");
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(betaDir, { recursive: true });

  fs.writeFileSync(
    path.join(alphaDir, "state.json"),
    JSON.stringify({
      id: "plan_1_alpha",
      slug: "alpha",
      status: "planning",
      request: "Alpha plan",
      project: "proj",
      feature: "alpha",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  fs.writeFileSync(
    path.join(alphaDir, "plan.md"),
    frontmatter({
      id: "plan_1_alpha",
      slug: "alpha",
      status: "planning",
      request: "Alpha plan",
      project: "proj",
      feature: "alpha",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );

  // beta has only a plan.md (no state.json) -> frontmatter fallback.
  fs.writeFileSync(
    path.join(betaDir, "plan.md"),
    frontmatter({
      id: "plan_2_beta",
      slug: "beta",
      status: "abandoned",
      request: "Beta plan",
      project: "proj",
      feature: "beta",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
  );

  try {
    const listed = await listPlanArtifacts(projectDir);
    const bySlug = new Map(listed.map((p) => [p.slug, p]));

    assert(listed.length === 2, `lists 2 plans (got ${listed.length})`);
    assert(bySlug.get("alpha")?.status === "planning", "alpha status from state.json");
    assert(bySlug.get("beta")?.status === "abandoned", "beta status from frontmatter");
    assert(bySlug.get("beta")?.title === "Beta plan", "beta title from request");

    // Persist a status change to BOTH files.
    await setArtifactStatus(path.join(alphaDir, "plan.md"), "approved");
    const state = JSON.parse(fs.readFileSync(path.join(alphaDir, "state.json"), "utf-8"));
    const md = fs.readFileSync(path.join(alphaDir, "plan.md"), "utf-8");
    assert(state.status === "approved", "state.json status persisted");
    assert(/^status: approved$/m.test(md), "frontmatter status persisted");

    console.log("plans selfcheck: all passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
