/**
 * ObsidianStore — the durable, human-owned mirror of the learning state.
 *
 * Plain node:fs + withFileMutationQueue. Never overwrites user prose: notes
 * are created once and only structured sections are appended/updated.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { Concept, LearningSettings } from "./state.js";
import { slugifyTopic } from "./store.js";

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "Obsidian");

export interface ConceptMeta {
  name: string;
  status: string;
  domain?: string;
  mastery: number;
  related?: string[];
}

export function resolveVaultPath(settings: LearningSettings): string | undefined {
  if (settings.obsidianVaultPath) return settings.obsidianVaultPath;
  if (fs.existsSync(DEFAULT_VAULT)) return DEFAULT_VAULT;
  return undefined;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "concept";
}

export function conceptsDir(vaultPath: string): string {
  return path.join(vaultPath, "Learning", "Concepts");
}

export function notePathFor(vaultPath: string, topic: string): string {
  return path.join(conceptsDir(vaultPath), `${sanitizeFileName(topic)}.md`);
}

function frontmatter(meta: ConceptMeta): string {
  const now = new Date().toISOString();
  return [
    "---",
    "type: concept",
    `name: ${JSON.stringify(meta.name)}`,
    `status: ${meta.status}`,
    `domain: ${JSON.stringify(meta.domain ?? "")}`,
    `mastery: ${meta.mastery}`,
    `created: ${now}`,
    `updated: ${now}`,
    "---",
    "",
  ].join("\n");
}

const NOTE_TEMPLATE = [
  "## Mental Model",
  "",
  "## Why It Matters",
  "",
  "## Related Concepts",
  "",
  "## My Understanding",
  "",
  "## Misconceptions",
  "",
  "## Review History",
  "",
].join("\n");

export async function createNote(
  vaultPath: string,
  topic: string,
  meta: ConceptMeta,
): Promise<string> {
  const file = notePathFor(vaultPath, topic);
  if (fs.existsSync(file)) return file;

  await withFileMutationQueue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, frontmatter(meta) + "# " + meta.name + "\n\n" + NOTE_TEMPLATE, "utf-8");
  });

  return file;
}

export async function readNote(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, "utf-8");
  } catch {
    return "";
  }
}

/** Append text under a `## Section`. Creates the section at the end if absent. */
export async function appendToNote(
  file: string,
  section: string,
  text: string,
): Promise<void> {
  if (!fs.existsSync(file)) return;

  await withFileMutationQueue(file, async () => {
    const content = await fs.promises.readFile(file, "utf-8");
    const heading = `## ${section}`;
    const idx = content.indexOf(heading);

    if (idx === -1) {
      await fs.promises.writeFile(
        file,
        content.trimEnd() + "\n\n" + heading + "\n\n" + text + "\n",
        "utf-8",
      );
      return;
    }

    const nextHeading = content.indexOf("\n## ", idx + heading.length);
    const insertAt = nextHeading === -1 ? content.length : nextHeading;
    const before = content.slice(0, insertAt).replace(/\s+$/, "");
    const after = content.slice(insertAt);
    const entry = `\n\n- ${new Date().toISOString()}: ${text}\n`;
    await fs.promises.writeFile(file, before + entry + "\n" + after, "utf-8");
  });
}

/** Add a wikilink from `from` to `to` if not already present. */
export async function linkNotes(vaultPath: string, from: string, to: string): Promise<void> {
  const file = notePathFor(vaultPath, from);
  if (!fs.existsSync(file)) return;

  const target = sanitizeFileName(to);
  await appendToNote(file, "Related Concepts", `[[${target}]]`);
}

export function findNote(vaultPath: string, topic: string): string | undefined {
  const file = notePathFor(vaultPath, topic);
  return fs.existsSync(file) ? file : undefined;
}

/** Update concept frontmatter (status/mastery/updated) in place. */
export async function updateNoteMeta(
  vaultPath: string,
  topic: string,
  updates: { status?: string; mastery?: number },
): Promise<void> {
  const file = notePathFor(vaultPath, topic);
  if (!fs.existsSync(file)) return;

  await withFileMutationQueue(file, async () => {
    const content = await fs.promises.readFile(file, "utf-8");
    const updated = content
      .replace(/^(status: ).*$/m, updates.status ? `$1${updates.status}` : "$1")
      .replace(/^(mastery: ).*$/m, updates.mastery !== undefined ? `$1${updates.mastery}` : "$1")
      .replace(/^(updated: ).*$/m, `$1${new Date().toISOString()}`);
    await fs.promises.writeFile(file, updated, "utf-8");
  });
}

export function noteExists(vaultPath: string, topic: string): boolean {
  return fs.existsSync(notePathFor(vaultPath, topic));
}

/**
 * Scaffold the vault skeleton (§32). Does NOT create `.obsidian/` — the
 * Obsidian app owns that on first open.
 */
export async function setupVault(vaultPath: string): Promise<string[]> {
  const dirs = [
    "Learning/Concepts",
    "Learning/Misconceptions",
    "Learning/Reviews",
    "Architecture",
    "Projects",
  ];

  const created: string[] = [];
  for (const d of dirs) {
    const full = path.join(vaultPath, d);
    if (!fs.existsSync(full)) {
      await fs.promises.mkdir(full, { recursive: true });
      created.push(full);
    }
  }

  const readme = path.join(vaultPath, "README.md");
  if (!fs.existsSync(readme)) {
    const text = [
      "# Obsidian Vault — Human Knowledge Layer",
      "",
      "This vault is the durable, human-owned record of what you understand.",
      "Pi maintains its own learning state in `~/.pi/learning/`; this vault is",
      "the inspectable mirror you own and edit.",
      "",
      "## Layers",
      "",
      "- `Learning/` — general engineering knowledge (concepts, misconceptions, reviews).",
      "- `Architecture/` — decisions and rationale.",
      "- `Projects/` — project-specific notes.",
      "",
      "Pi only appends structured sections to `Learning/Concepts/*.md`; your prose is never overwritten.",
      "",
    ].join("\n");
    await fs.promises.writeFile(readme, text, "utf-8");
    created.push(readme);
  }

  return created;
}

export function vaultStatus(vaultPath: string | undefined): {
  path: string | undefined;
  exists: boolean;
  conceptNotes: number;
} {
  if (!vaultPath) return { path: undefined, exists: false, conceptNotes: 0 };

  const dir = conceptsDir(vaultPath);
  let conceptNotes = 0;
  if (fs.existsSync(dir)) {
    conceptNotes = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .length;
  }

  return { path: vaultPath, exists: fs.existsSync(vaultPath), conceptNotes };
}

export function defaultVaultPath(): string {
  return DEFAULT_VAULT;
}

export { slugifyTopic };
