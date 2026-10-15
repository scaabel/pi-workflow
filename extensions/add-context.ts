/**
 * add-context extension
 *
 * Adds slash commands to attach directories, files, and screenshots to the
 * session context (Claude Code-style, no auto model turn):
 *
 *   /add-dir <path…>    Add one or more directories (recursive, gitignore-aware)
 *   /add <path…>        Add one or more files or images
 *   /screenshot         Capture a screen region (macOS) and attach
 *
 * Context is staged via sendMessage(..., { triggerTurn: false }) so the model
 * sees it on the next turn, exactly like Claude Code's /add-dir.
 */

import {
  readFile,
  readdir,
  stat,
  access,
} from "node:fs/promises";
import { resolve, relative, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectSupportedImageMimeTypeFromFile,
  resizeImage,
} from "@earendil-works/pi-coding-agent";

// ---------- Types (mirrors pi-ai) ----------

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

// ---------- Constants ----------

const MAX_BYTES = 100 * 1024; // 100 KB shared budget
const MAX_FILES = 200; // shared budget

const BINARY_EXTENSIONS = new Set([
  // images (handled separately, but listed to skip raw read)
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
  // archives
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  // documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // binaries / objects
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib",
  ".class", ".pyc", ".o", ".obj",
  ".wasm", ".bin",
  // media
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  // fonts
  ".woff", ".woff2", ".ttf", ".eot",
  // databases
  ".db", ".sqlite", ".sqlite3",
  // lock / compiled
  ".lock", ".min.js", ".min.css",
]);

const SKIP_DIRS = new Set([".git", "node_modules", ".pi", ".next", "dist", "build", "__pycache__"]);

interface Budget {
  bytes: number;
  files: number;
}

// ponytail: no .gitignore parsing; uses SKIP_DIRS + BINARY_EXTENSIONS list.
// Add .gitignore parsing if you regularly add dirs with many untracked ignored files.

// ---------- Pure helpers (exported for selfcheck) ----------

/** Split command args on whitespace, honoring "double-quoted" and 'single-quoted' paths. */
export function parsePaths(args: string): string[] {
  const paths: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inQuote) {
      if (c === inQuote) {
        inQuote = null;
      } else {
        current += c;
      }
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (current) {
        paths.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current) {
    paths.push(current);
  }
  return paths;
}

/** Check if a path should be treated as an image (by extension). */
export function isLikelyImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".bmp";
}

/** Check if a file extension is a known binary (should not be read as text). */
function isBinaryExt(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** Format a single file's relative path with size in a tree-like display. */
function formatEntry(relPath: string, size: number): string {
  const depth = relPath.split("/").length - 1;
  const indent = "  ".repeat(depth);
  const kb = (size / 1024).toFixed(1);
  return `${indent}├── ${relPath} (${kb} KB)`;
}

/** Build a directory tree string from a list of { relPath, size } entries. */
function buildTree(dirName: string, entries: { relPath: string; size: number }[]): string {
  if (entries.length === 0) {
    return `${dirName}/ (no readable files)`;
  }
  const totalKb = (entries.reduce((s, e) => s + e.size, 0) / 1024).toFixed(1);
  const lines = [`${dirName}/ (${entries.length} files, ${totalKb} KB)`];
  for (const entry of entries) {
    lines.push(formatEntry(entry.relPath, entry.size));
  }
  return lines.join("\n");
}

// ---------- Core collection ----------

/**
 * Collect readable file paths from a directory.
 * Returns tree display, file paths, and skipped items.
 * Mutates budget (shared across all dirs in one invocation).
 */
export async function collectFilesFromDir(
  dirPath: string,
  cwd: string,
  budget: Budget,
): Promise<{
  tree: string;
  filePaths: string[];
  fileSizes: Map<string, number>;
  skipped: string[];
}> {
  const absDir = resolve(cwd, dirPath);
  const filePaths: string[] = [];
  const fileSizes = new Map<string, number>();
  const skipped: string[] = [];
  const treeEntries: { relPath: string; size: number }[] = [];

  // Validate directory
  try {
    await access(absDir);
  } catch {
    return { tree: `Error: Directory not found: ${dirPath}`, filePaths: [], fileSizes, skipped };
  }

  const dirStat = await stat(absDir);
  if (!dirStat.isDirectory()) {
    return { tree: `Error: Not a directory: ${dirPath}`, filePaths: [], fileSizes, skipped };
  }

  // Recursively walk the directory
  async function walk(subDir: string) {
    let entries: import("node:fs/promises").Dirent[];
    try {
      entries = await readdir(subDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES) {
        // Budget exhausted — skip everything remaining
        if (entry.isDirectory()) {
          skipped.push(resolve(subDir, entry.name) + "/ (budget full)");
        } else {
          skipped.push(resolve(subDir, entry.name) + " (budget full)");
        }
        continue;
      }

      const fullPath = resolve(subDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push(fullPath + "/ (skip dir)");
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Skip binary files (except images, handled by /add)
      if (isBinaryExt(entry.name)) {
        skipped.push(fullPath + " (binary)");
        continue;
      }

      // Check file size before reading
      let fstat: import("node:fs").Stats;
      try {
        fstat = await stat(fullPath);
      } catch {
        continue;
      }

      if (fstat.size > 50_000) {
        // Skip files larger than 50 KB individually (protect against huge files)
        skipped.push(fullPath + " (>50 KB)");
        continue;
      }

      if (budget.bytes + fstat.size > MAX_BYTES || budget.files + 1 > MAX_FILES) {
        skipped.push(fullPath + " (budget full)");
        continue;
      }

      const relPath = relative(absDir, fullPath);
      filePaths.push(fullPath);
      fileSizes.set(fullPath, fstat.size);
      treeEntries.push({ relPath, size: fstat.size });
      budget.files++;
      budget.bytes += fstat.size;
    }
  }

  await walk(absDir);

  treeEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const tree = buildTree(dirPath, treeEntries);

  return { tree, filePaths, fileSizes, skipped };
}

// ---------- Message building ----------

interface FilePart {
  path: string;
  content: TextContent | ImageContentBlock;
}

/**
 * Read a single file and return its content as TextContent or ImageContentBlock.
 */
async function readFileContent(
  filePath: string,
): Promise<FilePart | { skipped: string } | null> {
  // Try image detection first (pi's native util)
  try {
    const mime = await detectSupportedImageMimeTypeFromFile(filePath);
    if (mime) {
      const bytes = await readFile(filePath);
      const resized = await resizeImage(bytes, mime);
      if (!resized) {
        return { skipped: `${filePath} (image resize failed)` };
      }
      return {
        path: filePath,
        content: { type: "image" as const, data: resized.data, mimeType: resized.mimeType },
      };
    }
  } catch {
    // Not an image or detection failed — try as text
  }

  // Try reading as text
  try {
    const content = await readFile(filePath, "utf-8");
    return {
      path: filePath,
      content: { type: "text" as const, text: `<file name="${filePath}">\n${content}\n</file>` },
    };
  } catch (err) {
    return { skipped: `${filePath} (read error: ${(err as Error).message})` };
  }
}

/**
 * Build the message content from file parts.
 * Returns a string (text-only) or mixed array (text + images).
 */
function buildMessageContent(parts: FilePart[]): string | (TextContent | ImageContentBlock)[] {
  const hasImages = parts.some((p) => p.content.type === "image");

  if (hasImages) {
    const blocks: (TextContent | ImageContentBlock)[] = [];
    for (const part of parts) {
      blocks.push(part.content);
    }
    return blocks;
  }

  // Text-only: join into a single string
  return parts.map((p) => p.content.text).join("\n\n");
}

/** Build the summary string shown to the user. */
function buildSummary(
  dirCount: number,
  fileCount: number,
  skippedCount: number,
  screenshot: boolean,
): string {
  if (screenshot) {
    return "Screenshot captured and added to context";
  }
  const parts: string[] = [];
  if (dirCount > 0) parts.push(`${dirCount} dir${dirCount > 1 ? "s" : ""}`);
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing added";
}

// ---------- Path completion ----------

async function completePath(prefix: string, cwd: string, directoriesOnly: boolean): Promise<Array<{ value: string; label: string }>> {
  const normalizedPrefix = prefix || ".";
  let dir = normalizedPrefix;
  let searchName = "";

  if (!normalizedPrefix.endsWith("/")) {
    dir = dirname(normalizedPrefix) || ".";
    searchName = normalizedPrefix;
  }

  const absDir = resolve(cwd, dir);
  try {
    const entries = await readdir(absDir, { withFileTypes: true });
    const matches = entries
      .filter((e) => {
        if (!e.name.startsWith(searchName)) return false;
        if (directoriesOnly && !e.isDirectory()) return false;
        return true;
      })
      .slice(0, 20)
      .map((e) => {
        const value = resolve(cwd, dir, e.name);
        const suffix = e.isDirectory() ? "/" : "";
        return {
          value: value + suffix,
          label: e.name + suffix,
        };
      });
    return matches.length > 0 ? matches : null;
  } catch {
    return null;
  }
}

// ---------- Extension factory ----------

export default function (pi: ExtensionAPI) {
  // ------ /add-dir ------
  pi.registerCommand("add-dir", {
    description: "Add one or more directories to session context (recursive)",
    getArgumentCompletions: async (prefix) => {
      // Get the last path segment being typed
      const segments = prefix.split(" ");
      const last = segments[segments.length - 1] || "";
      return completePath(last, process.cwd(), true);
    },
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /add-dir <path…>  (one or more directory paths)", "warning");
        return;
      }

      const paths = parsePaths(args.trim());
      if (paths.length === 0) {
        ctx.ui.notify("No paths provided", "warning");
        return;
      }

      const budget: Budget = { bytes: 0, files: 0 };
      const allTrees: string[] = [];
      const allFilePaths: string[] = [];
      const allSkipped: string[] = [];

      for (const p of paths) {
        const result = await collectFilesFromDir(p, ctx.cwd, budget);
        allTrees.push(result.tree);
        allFilePaths.push(...result.filePaths);
        allSkipped.push(...result.skipped);
      }

      if (allFilePaths.length === 0) {
        ctx.ui.notify(`No readable files found in: ${paths.join(", ")}`, "warning");
        return;
      }

      // Read file contents and build message
      const parts: FilePart[] = [];
      for (const fp of allFilePaths) {
        const result = await readFileContent(fp);
        if (result === null) continue;
        if ("skipped" in result) {
          allSkipped.push(result.skipped);
        } else {
          parts.push(result);
        }
      }

      if (parts.length === 0) {
        ctx.ui.notify("No readable files after loading", "warning");
        return;
      }

      // Build message: header + tree + content
      const header = `Added ${allFilePaths.length} file${allFilePaths.length > 1 ? "s" : ""} from ${paths.length} director${paths.length > 1 ? "ies" : "y"}:\n`;
      const content = buildMessageContent(parts);

      // If content is a string (text-only), prepend header and trees
      let finalContent: string | (TextContent | ImageContentBlock)[];
      if (typeof content === "string") {
        finalContent = header + allTrees.join("\n\n") + "\n\n--- File Contents ---\n\n" + content;
      } else {
        // Mixed (has images): prepend header + tree as text block
        const textBlock: TextContent = {
          type: "text",
          text: header + allTrees.join("\n\n") + "\n\n--- File Contents ---",
        };
        finalContent = [textBlock, ...content];
      }

      pi.sendMessage(
        {
          customType: "add-context",
          content: finalContent,
          display: true,
          details: { paths, skipped: allSkipped },
        },
        { triggerTurn: false },
      );

      ctx.ui.notify(buildSummary(paths.length, parts.length, allSkipped.length, false), "info");
    },
  });

  // ------ /add ------
  pi.registerCommand("add", {
    description: "Add one or more files or images to session context",
    getArgumentCompletions: async (prefix) => {
      const segments = prefix.split(" ");
      const last = segments[segments.length - 1] || "";
      return completePath(last, process.cwd(), false);
    },
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /add <path…>  (one or more file paths)", "warning");
        return;
      }

      const paths = parsePaths(args.trim());
      if (paths.length === 0) {
        ctx.ui.notify("No paths provided", "warning");
        return;
      }

      const parts: FilePart[] = [];
      const skipped: string[] = [];

      for (const p of paths) {
        const absPath = resolve(ctx.cwd, p);
        try {
          await access(absPath);
        } catch {
          skipped.push(`${p} (not found)`);
          continue;
        }

        const fstat = await stat(absPath);
        if (fstat.isDirectory()) {
          // If it's a directory, delegate to collectFilesFromDir
          const dirResult = await collectFilesFromDir(p, ctx.cwd, { bytes: 0, files: 0 });
          for (const fp of dirResult.filePaths) {
            const result = await readFileContent(fp);
            if (result === null) continue;
            if ("skipped" in result) {
              skipped.push(result.skipped);
            } else {
              parts.push(result);
            }
          }
          skipped.push(...dirResult.skipped);
          continue;
        }

        if (fstat.size > 50_000) {
          skipped.push(`${p} (>50 KB)`);
          continue;
        }

        const result = await readFileContent(absPath);
        if (result === null) continue;
        if ("skipped" in result) {
          skipped.push(result.skipped);
        } else {
          parts.push(result);
        }
      }

      if (parts.length === 0) {
        ctx.ui.notify(`No readable files: ${paths.join(", ")}`, "warning");
        return;
      }

      const content = buildMessageContent(parts);
      const header = `Added ${parts.length} file${parts.length > 1 ? "s" : ""}:\n`;
      let finalContent: string | (TextContent | ImageContentBlock)[];
      if (typeof content === "string") {
        finalContent = header + content;
      } else {
        finalContent = [{ type: "text" as const, text: header }, ...content];
      }

      pi.sendMessage(
        {
          customType: "add-context",
          content: finalContent,
          display: true,
          details: { paths, skipped },
        },
        { triggerTurn: false },
      );

      ctx.ui.notify(buildSummary(0, parts.length, skipped.length, false), "info");
    },
  });

  // ------ /screenshot ------
  pi.registerCommand("screenshot", {
    description: "Capture a screen region and attach to context (macOS)",
    handler: async (_args, ctx) => {
      // Platform check
      if (process.platform !== "darwin") {
        ctx.ui.notify("/screenshot is macOS only. Use paste (Ctrl+V) or /add <image> on other platforms.", "warning");
        return;
      }

      const tmpPng = resolve(tmpdir(), `pi-screenshot-${randomUUID()}.png`);

      try {
        // Interactive screencapture (-i), saved to file
        await ctx.exec("screencapture", ["-i", tmpPng]);

        // Check if file was created (user didn't cancel)
        try {
          await access(tmpPng);
        } catch {
          ctx.ui.notify("Screenshot cancelled", "info");
          return;
        }

        const mime = await detectSupportedImageMimeTypeFromFile(tmpPng);
        if (!mime) {
          ctx.ui.notify("Captured file is not a recognized image", "warning");
          return;
        }

        const bytes = await readFile(tmpPng);
        const resized = await resizeImage(bytes, mime);
        if (!resized) {
          ctx.ui.notify("Failed to process screenshot image", "warning");
          return;
        }

        const content: (TextContent | ImageContentBlock)[] = [
          { type: "text" as const, text: "Screenshot:" },
          { type: "image" as const, data: resized.data, mimeType: resized.mimeType },
        ];

        pi.sendMessage(
          {
            customType: "add-context",
            content,
            display: true,
            details: { path: tmpPng },
          },
          { triggerTurn: false },
        );

        ctx.ui.notify("Screenshot captured and added to context", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Screenshot failed: ${msg}`, "error");
      }
    },
  });
}
