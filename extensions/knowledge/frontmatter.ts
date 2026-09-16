/**
 * Minimal YAML frontmatter parse/serialize for the knowledge repo.
 *
 * Supports the documented subset only: top-level scalars, block lists
 * (`tags:`, `related:`), and the `relationships:` list-of-maps. Round-trips
 * the exact source so unknown keys and user prose are never rewritten.
 *
 * // ponytail: hand-rolled ~100-line parser instead of the `yaml` npm dep.
 * // Swap in `yaml` only if nested structures, anchors, or multiline scalars
 * // actually appear in artifacts.
 */

export interface Relationship {
  type: string;
  target: string;
}

export interface ParsedHead {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  relationships: Relationship[];
}

export interface Meta {
  id?: string;
  type?: string;
  relationships: Relationship[];
  title?: string;
}

/** Split `content` into frontmatter `head` (without `---` delimiters) and `body`. */
export function splitFrontmatter(content: string): { head: string; body: string } | null {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return null;
  return { head: m[1], body: content.slice(m[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t[t.length - 1] === q) return t.slice(1, -1);
  }
  return t;
}

/** Parse a frontmatter block (text between the `---` delimiters). */
export function parseHead(head: string): ParsedHead {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const relationships: Relationship[] = [];
  const lines = head.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] ?? "";
    const rest = (m[2] ?? "").trim();

    if (key === "relationships") {
      let j = i + 1;
      while (j < lines.length) {
        const nl = lines[j] ?? "";
        if (nl.trim() === "") {
          j++;
          continue;
        }
        const item = nl.match(/^\s*-\s*type:\s*([^\s,]+)\s*(?:,\s*target:\s*([^\s,]+)\s*)?$/);
        if (item) {
          let target = item[2] ?? "";
          if (!target && j + 1 < lines.length) {
            const tm = lines[j + 1]!.match(/^\s*target:\s*([^\s,]+)\s*$/);
            if (tm) {
              target = tm[1] ?? "";
              j++;
            }
          }
          if (item[1]) relationships.push({ type: item[1], target });
          j++;
          continue;
        }
        break;
      }
      i = j;
      continue;
    }

    if (rest !== "") {
      scalars[key] = unquote(rest);
      i++;
      continue;
    }

    // Block list of scalar items.
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const nl = lines[j] ?? "";
      const im = nl.match(/^\s+-\s+(.*)$/);
      if (!im) break;
      items.push(unquote(im[1] ?? ""));
      j++;
    }
    if (items.length > 0) {
      lists[key] = items;
      i = j;
    } else {
      scalars[key] = "";
      i++;
    }
  }

  return { scalars, lists, relationships };
}

/** Parse a whole document's frontmatter into `{ id, type, relationships, title }`. */
export function getMeta(content: string): Meta {
  const split = splitFrontmatter(content);
  const meta: Meta = { relationships: [] };
  if (split) {
    const parsed = parseHead(split.head);
    meta.id = parsed.scalars.id;
    meta.type = parsed.scalars.type;
    meta.relationships = parsed.relationships;
  }
  const h1 = split ? split.body.match(/^#\s+(.+)$/m) : content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) meta.title = h1[1].trim();
  return meta;
}

export function serializeRelationships(rels: Relationship[]): string {
  if (rels.length === 0) return "";
  const lines = ["relationships:"];
  for (const r of rels) {
    lines.push(`  - type: ${r.type}`);
    lines.push(`    target: ${r.target}`);
  }
  return lines.join("\n");
}

/**
 * Rewrite the `relationships:` frontmatter list in place, preserving every
 * other frontmatter line and the body byte-for-byte. Creates a frontmatter
 * block if the document has none.
 */
export function setRelationships(content: string, relationships: Relationship[]): string {
  const split = splitFrontmatter(content);

  if (!split) {
    const rel = serializeRelationships(relationships);
    if (!rel) return content;
    const body = content.replace(/^\s+/, "");
    return `---\n${rel}\n---\n\n${body}`;
  }

  const headLines = split.head.split(/\r?\n/);
  const kept: string[] = [];
  let i = 0;
  while (i < headLines.length) {
    const line = headLines[i] ?? "";
    if (/^relationships:/.test(line.trimStart()) && !/^\s/.test(line)) {
      i++;
      while (i < headLines.length && /^\s/.test(headLines[i] ?? "")) i++;
      continue;
    }
    kept.push(line);
    i++;
  }

  let head = kept.join("\n").replace(/\s+$/, "");
  const rel = serializeRelationships(relationships);
  if (rel) head = head ? head + "\n" + rel : rel;

  return `---\n${head.trimEnd()}\n---\n\n${split.body}`;
}
