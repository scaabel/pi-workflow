/**
 * KnowledgeAdapter — the single interface the rest of the workflow uses to
 * read/write the git-backed knowledge repo. Backend is filesystem + git;
 * the relationship graph is derived from frontmatter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { relate, resolveId, scan, usedIn, type ScanResult, type Artifact } from "./graph.js";
import { check, type CheckReport } from "./validate.js";
import { generateIndexes } from "./indexgen.js";
import {
  defaultExec,
  gitCommit,
  gitDiff,
  gitMove,
  gitPush,
  gitRestore,
  gitStatus,
  isGitRepo,
  type ExecFn,
} from "./git.js";
import { search as fsSearch, type SearchHit } from "./search.js";
import {
  conceptPath,
  featureDir,
  featureId,
  featurePath,
  humanize,
  idFor,
  isSafeRelPath,
  joinSafe,
  normalizeCategory,
  planId,
  planPath,
  projectId,
  projectReadmePath,
  sanitizeSlug,
  today,
  TYPE_BY_CATEGORY,
  type LearningCategory,
} from "./layout.js";

export interface ConceptMeta {
  title?: string;
  tags?: string[];
  related?: string[];
}

export interface LinkResult {
  ok: boolean;
  output: string;
}

export interface KnowledgeAdapter {
  readonly dir: string;
  scan(): Promise<ScanResult>;
  resolveId(id: string): Promise<Artifact | undefined>;
  usedIn(id: string): Promise<Array<{ id: string; type: string; title?: string; relType: string }>>;
  search(query: string): Promise<SearchHit[]>;
  read(relPath: string): Promise<string>;
  create(relPath: string, content: string): Promise<string>;
  update(relPath: string, content: string): Promise<void>;
  link(from: string, to: string, type: string): Promise<void>;
  archive(relPath: string, archiveRelPath: string): Promise<LinkResult>;
  scaffoldFeature(project: string, feature: string): Promise<string>;
  appendLearning(project: string, feature: string, text: string): Promise<string>;
  createConcept(category: string, slug: string, meta: ConceptMeta, body: string): Promise<string>;
  publishPlan(input: { slug: string; project: string; feature: string; planBody: string }): Promise<{ planRel: string; featureRel: string }>;
  check(): Promise<CheckReport>;
  index(): Promise<string[]>;
  diff(): Promise<string>;
  status(): Promise<string>;
  commit(message: string): Promise<LinkResult>;
  push(): Promise<LinkResult>;
  isRepo(): Promise<boolean>;
  restore(): Promise<LinkResult>;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  settingsPath?: string;
  fallback?: string;
}

export function resolveKnowledgeDir(opts?: ResolveOptions): string {
  const env = opts?.env ?? process.env;
  if (env.PI_KNOWLEDGE_DIR && env.PI_KNOWLEDGE_DIR.trim()) return env.PI_KNOWLEDGE_DIR.trim();

  const settingsPath = opts?.settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { knowledgeDir?: unknown };
    if (typeof settings.knowledgeDir === "string" && settings.knowledgeDir.trim()) {
      return settings.knowledgeDir.trim();
    }
  } catch {
    /* settings.json may not exist yet */
  }

  return opts?.fallback ?? path.join(os.homedir(), ".local", "share", "pi", "knowledge");
}

function asCategory(category: string): LearningCategory {
  return normalizeCategory(category);
}

function conceptBody(title: string, body: string): string {
  const trimmed = body.trim();
  if (/^#\s+\S/m.test(trimmed)) return trimmed + "\n";
  return `# ${title}\n\n${trimmed}\n`;
}

export function createKnowledgeAdapter(dir: string, opts?: { exec?: ExecFn }): KnowledgeAdapter {
  const exec = opts?.exec ?? defaultExec;

  const mkdirp = async (rel: string) => {
    const abs = joinSafe(dir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    return abs;
  };

  return {
    dir,

    scan: () => scan(dir),

    async resolveId(id) {
      return resolveId(await scan(dir), id);
    },

    async usedIn(id) {
      return usedIn(await scan(dir), id);
    },

    search: (query) => fsSearch(dir, query),

    async read(relPath) {
      return fs.promises.readFile(joinSafe(dir, relPath), "utf-8");
    },

    async create(relPath, content) {
      const abs = await mkdirp(relPath);
      await fs.promises.writeFile(abs, content, "utf-8");
      return abs;
    },

    async update(relPath, content) {
      const abs = await mkdirp(relPath);
      await fs.promises.writeFile(abs, content, "utf-8");
    },

    async link(from, to, type) {
      await relate(await scan(dir), from, to, type);
    },

    async archive(relPath, archiveRelPath) {
      if (!isSafeRelPath(relPath) || !isSafeRelPath(archiveRelPath)) {
        return { ok: false, output: "unsafe path" };
      }
      const r = await gitMove(dir, relPath, archiveRelPath, exec);
      return { ok: r.code === 0, output: r.stdout || r.stderr };
    },

    async scaffoldFeature(project, feature) {
      const fDir = featureDir(project, feature);
      const fId = featureId(project, feature);
      const pId = projectId(project);

      // Project README (the `project` node) if missing.
      const projRel = projectReadmePath(project);
      if (!fs.existsSync(joinSafe(dir, projRel))) {
        await this.create(projRel, `---\nid: ${pId}\ntype: project\n---\n\n# ${humanize(project)}\n\n`);
      }

      const files: Array<[string, string]> = [
        [
          path.join(fDir, "feature.md"),
          `---\nid: ${fId}\ntype: feature\nproject: ${sanitizeSlug(project)}\n---\n\n# ${humanize(feature)}\n\n## What\n\n## Why\n\n`,
        ],
        [
          path.join(fDir, "implementation.md"),
          `# Implementation\n\n## Architecture\n\n## Backend\n\n## Frontend\n\n## API\n\n`,
        ],
        [path.join(fDir, "learnings.md"), `# Learnings\n\n`],
      ];

      for (const [rel, content] of files) {
        if (!fs.existsSync(joinSafe(dir, rel))) await this.create(rel, content);
      }

      return path.join(fDir, "feature.md");
    },

    async appendLearning(project, feature, text) {
      const rel = path.join(featureDir(project, feature), "learnings.md");
      const abs = joinSafe(dir, rel);
      let content = "";
      try {
        content = await fs.promises.readFile(abs, "utf-8");
      } catch {
        content = "# Learnings\n\n";
      }
      const entry = `## ${today()}\n\n${text.trim()}\n`;
      const updated = content.trimEnd() + "\n\n" + entry;
      await fs.promises.writeFile(abs, updated, "utf-8");
      return rel;
    },

    async createConcept(category, slug, meta, body) {
      const cat = asCategory(category);
      const type = TYPE_BY_CATEGORY[cat];
      const id = idFor(type, slug);
      const rel = conceptPath(cat, slug);

      const lines = ["---", `id: ${id}`, `type: ${type}`];
      if (meta.tags && meta.tags.length > 0) {
        lines.push("tags:");
        for (const t of meta.tags) lines.push(`  - ${t}`);
      }
      if (meta.related && meta.related.length > 0) {
        lines.push("related:");
        for (const r of meta.related) lines.push(`  - ${r}`);
      }
      lines.push("---", "");
      const frontmatter = lines.join("\n");
      const content = frontmatter + conceptBody(meta.title ?? humanize(slug), body);

      const abs = joinSafe(dir, rel);
      if (!fs.existsSync(abs)) await this.create(rel, content);
      return rel;
    },

    async publishPlan(input) {
      const date = today();
      const pId = planId(date, input.slug);
      const fId = featureId(input.project, input.feature);
      const projId = projectId(input.project);

      const featureRel = await this.scaffoldFeature(input.project, input.feature);

      const planRel = planPath("active", date, input.slug);
      const fm = [
        "---",
        `id: ${pId}`,
        "type: plan",
        `project: ${sanitizeSlug(input.project)}`,
        `feature: ${sanitizeSlug(input.feature)}`,
        "status: active",
        `created: ${date}`,
        "---",
        "",
      ].join("\n");
      const content = fm + input.planBody.trim() + "\n";
      if (!fs.existsSync(joinSafe(dir, planRel))) await this.create(planRel, content);

      await this.link(projId, fId, "contains");
      await this.link(pId, fId, "implements");

      return { planRel, featureRel };
    },

    check: async () => check(await scan(dir)),

    index: async () => generateIndexes(await scan(dir)),

    async diff() {
      if (!(await isGitRepo(dir, exec))) return "not a git repository";
      return gitDiff(dir, exec);
    },

    async status() {
      if (!(await isGitRepo(dir, exec))) return "not a git repository";
      return gitStatus(dir, exec);
    },

    async commit(message) {
      if (!(await isGitRepo(dir, exec))) return { ok: false, output: "not a git repository" };
      const r = await gitCommit(dir, message, exec);
      return { ok: r.code === 0, output: r.stdout || r.stderr };
    },

    async push() {
      if (!(await isGitRepo(dir, exec))) return { ok: false, output: "not a git repository" };
      const r = await gitPush(dir, exec);
      return { ok: r.code === 0, output: r.stdout || r.stderr };
    },

    isRepo: () => isGitRepo(dir, exec),

    async restore() {
      if (!(await isGitRepo(dir, exec))) return { ok: false, output: "not a git repository" };
      const r = await gitRestore(dir, exec);
      return { ok: r.code === 0, output: r.stdout || r.stderr };
    },
  };
}

/** Scaffold the pi-knowledge repo skeleton. Returns created directory paths. */
export async function scaffoldRepo(dir: string): Promise<string[]> {
  const dirs = [
    "plans/active",
    "plans/completed",
    "plans/abandoned",
    "learning/concepts",
    "learning/patterns",
    "learning/debugging",
    "learning/architecture",
    "learning/tools",
    "projects",
    "decisions",
    "sessions",
    "_index",
  ];
  const created: string[] = [];
  for (const d of dirs) {
    const full = path.join(dir, d);
    if (!fs.existsSync(full)) {
      await fs.promises.mkdir(full, { recursive: true });
      created.push(full);
    }
  }
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    await fs.promises.writeFile(
      readme,
      [
        "# pi-knowledge",
        "",
        "Personal engineering knowledge base. Markdown + YAML frontmatter + Git.",
        "",
        "## Layout",
        "",
        "- `plans/` — implementation intent (active / completed / abandoned).",
        "- `projects/<project>/features/<feature>/` — feature, implementation, learnings.",
        "- `learning/` — reusable concepts / patterns / debugging / architecture / tools.",
        "- `decisions/` — architectural decisions (ADR-style).",
        "- `_index/` — generated indexes (run `/knowledge index`).",
        "",
        "Every artifact has an `id` + `type` and a `relationships:` list. Run",
        "`/knowledge check` to validate the graph.",
        "",
      ].join("\n"),
      "utf-8",
    );
    created.push(readme);
  }
  return created;
}
