/**
 * oh-my-pi-style plan review overlay.
 *
 * A faithful port of oh-my-pi's `PlanReviewOverlay` (v18.1.4) adapted to the
 * pi 0.85.1 API surface:
 *
 *   ┌ Plan Review ──────┬─────────────┐
 *   │ › Introduction    │ plan body   │   ToC sidebar (wide terminals, ≥2
 *   │ › Step 1          │ …           │   headings): cursor `›`, current-
 *   ├───────────────────┼─────────────┤   section glow `▎`, annotation `✎`
 *   │ Plan mode …       │ prompt title│
 *   │ ▶ Approve …       │ options     │
 *   ├─────────────────────────────────┤
 *   │ footer help                     │
 *   └─────────────────────────────────┘
 *
 * Focus regions (`toc`/`body`/`actions`) cycle with Tab/Shift+Tab; the default
 * focus is `actions`. Vim keys work everywhere: ↑/↓ and k/j move, h/l step
 * between regions, g/G jump top/bottom, PgUp/PgDn page, and in the body `a`
 * annotates the visible line, in the sidebar `a` annotates a section, `d`
 * deletes it, `u` undoes. Accumulated annotations/deletions are emitted as
 * Refine-feedback markdown through `onFeedbackChange`.
 *
 * // ponytail: body windowing is hand-rolled (plain component) because
 * // pi-tui's ScrollView only scrolls under the alt-screen layout engine.
 * // Skipped: mouse hit-testing, model-tier slider, external editor — see the
 * // plan's follow-ups.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  joinPlanSections,
  parsePlanSections,
  sectionDeletionSpan,
} from "./plan-sections.js";

/** Title shown in the overlay's top border. */
const OVERLAY_TITLE = "Plan Review";
/** Minimum plan-body rows kept visible even on short terminals. */
const MIN_BODY_ROWS = 3;
/** Sidebar gates: enough headings, a wide terminal, and a usable body column. */
const SIDEBAR_MIN_HEADINGS = 2;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
/** Persisted line-context cap; render-time captions clamp again to the viewport. */
const MAX_ANNOTATION_CONTEXT_WIDTH = 120;
/** Default trailing footer hint when the caller supplies none. */
const DEFAULT_HELP_SUFFIX = "esc cancel";
/** Option cursor glyph (pi 0.85.1 has no `theme.nav.cursor`). */
const CURSOR = "▸ ";

/** Box-drawing glyphs (pi 0.85.1 has no `theme.boxRound`). */
const G = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  teeRight: "├",
  teeLeft: "┤",
  teeDown: "┬",
  teeUp: "┴",
} as const;

interface ViewTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

type Focus = "toc" | "body" | "actions";

type AnnotationTarget =
  | { kind: "section" }
  | { kind: "line"; row: number; context: string; contextTruncated: boolean };

interface OverlayAnnotation {
  note: string;
  target: AnnotationTarget;
}

interface OverlaySection {
  level: number;
  title: string;
  raw: string;
  md: Markdown;
  annotations: OverlayAnnotation[];
}

interface LineAnchorContext {
  text: string;
  truncated: boolean;
}

interface BodyRowAnchor {
  sectionIndex: number;
  row: number;
  context: string;
  contextTruncated: boolean;
}

interface UndoEntry {
  text: string;
  annotations: OverlayAnnotation[][];
  deleted: string[];
}

interface BodyCache {
  width: number;
  lines: string[];
  anchors: BodyRowAnchor[];
  offsets: number[];
}

/* ----------------------------------------------------------------
 * Chrome helpers (ported from overlay-box.ts, hard-coded glyphs)
 * ---------------------------------------------------------------- */

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + " ".repeat(width - w);
  const cut = truncateToWidth(text, width);
  const cw = visibleWidth(cut);
  return cw < width ? cut + " ".repeat(width - cw) : cut;
}

function topBorder(theme: ViewTheme, width: number, title: string): string {
  const inner = Math.max(0, width - 2);
  if (!title) return theme.fg("border", G.topLeft + G.horizontal.repeat(inner) + G.topRight);
  const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
  const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
  return (
    theme.fg("border", G.topLeft + G.horizontal) +
    theme.bold(theme.fg("accent", shown)) +
    theme.fg("border", G.horizontal.repeat(fillWidth) + G.topRight)
  );
}

function divider(theme: ViewTheme, width: number): string {
  return theme.fg("border", G.teeRight + G.horizontal.repeat(Math.max(0, width - 2)) + G.teeLeft);
}

function bottomBorder(theme: ViewTheme, width: number): string {
  return theme.fg("border", G.bottomLeft + G.horizontal.repeat(Math.max(0, width - 2)) + G.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
function row(theme: ViewTheme, content: string, width: number): string {
  return `${theme.fg("border", G.vertical)} ${fit(content, Math.max(0, width - 4))} ${theme.fg("border", G.vertical)}`;
}

/** Body content width for a two-column overlay of total `width`. */
function splitBodyWidth(width: number, sidebarWidth: number): number {
  return Math.max(0, width - sidebarWidth - 7);
}

function splitDividerCol(sidebarWidth: number): number {
  return sidebarWidth + 3;
}

/** Top border carrying the title, split by a `┬` over the column divider. */
function topBorderSplit(theme: ViewTheme, width: number, title: string, sidebarWidth: number): string {
  const dividerCol = splitDividerCol(sidebarWidth);
  const leftLen = Math.max(0, dividerCol - 1);
  const rightLen = Math.max(0, width - 2 - dividerCol);
  let left: string;
  if (!title) {
    left = theme.fg("border", G.topLeft + G.horizontal.repeat(leftLen));
  } else {
    const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
    const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
    left =
      theme.fg("border", G.topLeft + G.horizontal) +
      theme.bold(theme.fg("accent", shown)) +
      theme.fg("border", G.horizontal.repeat(fillWidth));
  }
  return left + theme.fg("border", G.teeDown + G.horizontal.repeat(rightLen) + G.topRight);
}

/** Section rule that closes the sidebar column with a `┴` over the divider. */
function dividerSplit(theme: ViewTheme, width: number, sidebarWidth: number): string {
  const dividerCol = splitDividerCol(sidebarWidth);
  const leftLen = Math.max(0, dividerCol - 1);
  const rightLen = Math.max(0, width - 2 - dividerCol);
  return theme.fg(
    "border",
    G.teeRight + G.horizontal.repeat(leftLen) + G.teeUp + G.horizontal.repeat(rightLen) + G.teeLeft,
  );
}

/** A two-column content row: `│ sidebar │ body │`, each inset by one column. */
function splitRow(theme: ViewTheme, sidebar: string, body: string, width: number, sidebarWidth: number): string {
  const bodyWidth = splitBodyWidth(width, sidebarWidth);
  const bar = theme.fg("border", G.vertical);
  return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
}

/* ----------------------------------------------------------------
 * Plain-text helpers
 * ---------------------------------------------------------------- */

/** Strip SGR color sequences and expand tabs for annotation-context matching. */
function plainText(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\t/g, "    ").trimEnd();
}

function extractPlanTitle(text: string, fallback: string): string {
  const patterns = [
    /^#{1,6}\s*Plan\s*:\s*(.+)$/im,
    /^#{1,6}\s*Implementation Plan\s*:\s*(.+)$/im,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  const heading = /^#{1,6}\s+(.+)$/m.exec(text);

  if (heading?.[1]?.trim()) {
    return heading[1].trim();
  }

  return fallback;
}

/* ----------------------------------------------------------------
 * View
 * ---------------------------------------------------------------- */

class PlanReviewView {
  public onPick?: (option: string) => void;
  public onCancel?: () => void;
  public onCopyPlan?: (content: string) => void;
  public onPlanEdited?: (content: string) => void;
  public onFeedbackChange?: (feedback: string) => void;

  private readonly theme: ViewTheme;
  private mdTheme = getMarkdownTheme();

  private sections: OverlaySection[] = [];
  private toc: number[] = [];
  private tocBaseLevel = 1;
  private sectionOffsets: number[] = [];
  private bodyRowAnchors: BodyRowAnchor[] = [];
  private undo: UndoEntry[] = [];
  private deleted: string[] = [];

  private readonly options: string[];
  private readonly disabled: Set<number>;
  private readonly helpSuffix: string;
  private readonly promptTitle: string;
  private readonly meta: string[];

  private selectedIndex = 0;

  private focus: Focus = "actions";
  private tocCursor = 0;
  private sidebarShown = false;
  private pendingScrollToToc = false;
  private scrollProgress = 0;
  private scroll = 0;

  private annotating = false;
  private readonly input: Input;
  private annotationTarget:
    | BodyRowAnchor
    | { sectionIndex: number; row: null; context: null }
    | undefined;

  private bodyLines: string[] = [];
  private currentRegionRows = 0;
  private bodyCache?: BodyCache;

  constructor(theme: ViewTheme, options: PlanViewOptions) {
    this.theme = theme;
    this.promptTitle = options.promptTitle ?? options.title;
    this.meta = options.meta ?? [];
    this.helpSuffix = options.helpText ?? DEFAULT_HELP_SUFFIX;
    this.options = options.actions.length > 0 ? options.actions : ["Approve", "Cancel"];
    this.disabled = new Set(
      (options.disabledIndices ?? []).filter(
        (i) => Number.isInteger(i) && i >= 0 && i < this.options.length,
      ),
    );
    this.selectedIndex = this.coerceIndex(options.initialIndex ?? 0);
    this.input = new Input();
    this.input.onSubmit = (value) => this.submitAnnotation(value);
    this.input.onEscape = () => this.exitAnnotate();
    this.setSections(options.planText);
  }

  invalidate(): void {
    this.mdTheme = getMarkdownTheme();
    for (const section of this.sections) section.md = new Markdown(section.raw, 1, 0, this.mdTheme);
    this.bodyCache = undefined;
  }

  private setSections(planText: string): void {
    this.sections = parsePlanSections(planText).map((section) => ({
      level: section.level,
      title: section.title,
      raw: section.raw,
      md: new Markdown(section.raw, 1, 0, this.mdTheme),
      annotations: [],
    }));
    this.rebuildToc();
    this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
    this.bodyCache = undefined;
  }

  private rebuildToc(): void {
    const headings: number[] = [];
    for (let i = 0; i < this.sections.length; i++) {
      if (this.sections[i]!.level >= 1) headings.push(i);
    }
    // Drop the plan's title from the ToC: a single shallowest heading at the
    // top of the document is the plan name itself. Plans with several
    // top-level sections keep them all.
    let minLevel = Number.POSITIVE_INFINITY;
    for (const i of headings) minLevel = Math.min(minLevel, this.sections[i]!.level);
    const topLevel = headings.filter((i) => this.sections[i]!.level === minLevel);
    const titleIndex = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0] : -1;
    this.toc = headings.filter((i) => i !== titleIndex);
    this.tocBaseLevel = this.toc.length > 0 ? Math.min(...this.toc.map((i) => this.sections[i]!.level)) : 1;
  }

  /* ------------------------------------------------------------
   * Option selection
   * ------------------------------------------------------------ */

  /** Clamp `index` to range, then walk to the nearest enabled option. */
  private coerceIndex(index: number): number {
    const max = this.options.length - 1;
    if (max < 0) return -1;
    const clamped = Math.max(0, Math.min(index, max));
    if (!this.disabled.has(clamped)) return clamped;
    for (let i = clamped + 1; i <= max; i++) if (!this.disabled.has(i)) return i;
    for (let i = clamped - 1; i >= 0; i--) if (!this.disabled.has(i)) return i;
    return clamped;
  }

  private firstEnabledIndex(): number {
    for (let i = 0; i < this.options.length; i++) if (!this.disabled.has(i)) return i;
    return -1;
  }

  /** Move the option cursor by `delta`, skipping disabled rows, stopping at the list edge. */
  private moveSelection(delta: number): void {
    const max = this.options.length - 1;
    if (max < 0) return;
    let index = this.selectedIndex;
    while (true) {
      const next = Math.max(0, Math.min(index + delta, max));
      if (next === index) return;
      index = next;
      if (!this.disabled.has(index)) {
        this.selectedIndex = index;
        return;
      }
    }
  }

  private confirmSelection(): void {
    const index = this.selectedIndex;
    if (index >= 0 && index < this.options.length && !this.disabled.has(index)) {
      this.onPick?.(this.options[index]!);
    }
  }

  /* ------------------------------------------------------------
   * Scroll / region plumbing
   * ------------------------------------------------------------ */

  private regionRows(): number {
    const termHeight = (process.stdout as { rows?: number }).rows ?? 40;
    const footerLines = this.annotating ? 3 : 1;
    const chrome = 4 + 1 + this.meta.length + this.options.length + footerLines;
    return Math.max(MIN_BODY_ROWS, termHeight - chrome);
  }

  private maxScroll(): number {
    const rows = this.currentRegionRows || this.regionRows();
    return Math.max(0, this.bodyLines.length - rows);
  }

  private clampScroll(): void {
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
  }

  private captureScrollProgress(): void {
    const maxOffset = this.maxScroll();
    if (maxOffset > 0) this.scrollProgress = this.scroll / maxOffset;
  }

  private layoutBody(lines: string[], regionRows: number): void {
    const maxOffsetBefore = this.maxScroll();
    if (maxOffsetBefore > 0) this.scrollProgress = this.scroll / maxOffsetBefore;
    this.bodyLines = lines;
    this.currentRegionRows = regionRows;
    const maxOffset = this.maxScroll();
    this.scroll = maxOffset > 0 ? Math.round(this.scrollProgress * maxOffset) : 0;
    this.clampScroll();
  }

  private cycleRegion(direction: number): void {
    const regions: Focus[] = this.sidebarShown ? ["toc", "body", "actions"] : ["body", "actions"];
    const current = regions.indexOf(this.focus);
    const base = current < 0 ? regions.length - 1 : current;
    this.setFocus(regions[(base + direction + regions.length) % regions.length]!);
  }

  private setFocus(focus: Focus): void {
    this.focus = focus;
    if (focus === "toc") this.tocCursor = this.deriveTocCursorFromScroll();
  }

  private moveTocCursor(delta: number): void {
    if (this.toc.length === 0) return;
    const next = Math.max(0, Math.min(this.toc.length - 1, this.tocCursor + delta));
    if (next === this.tocCursor) return;
    this.tocCursor = next;
    this.scrubBodyToToc();
  }

  /** Scroll the body so the selected ToC section's heading sits at the top. */
  private scrubBodyToToc(): void {
    const sectionIndex = this.toc[this.tocCursor];
    if (sectionIndex === undefined) return;
    const offset = this.sectionOffsets[sectionIndex];
    if (offset !== undefined) {
      this.scroll = offset;
      this.clampScroll();
      this.captureScrollProgress();
    }
  }

  /** Greatest ToC position whose section starts at or above the scroll offset. */
  private deriveTocCursorFromScroll(): number {
    if (this.toc.length === 0) return 0;
    const scrollOffset = this.scroll;
    let current = 0;
    for (let i = 0; i < this.sections.length; i++) {
      if ((this.sectionOffsets[i] ?? 0) <= scrollOffset) current = i;
      else break;
    }
    let pos = 0;
    for (let p = 0; p < this.toc.length; p++) {
      if ((this.toc[p] ?? 0) <= current) pos = p;
      else break;
    }
    return pos;
  }

  /* ------------------------------------------------------------
   * Annotations / deletion / feedback
   * ------------------------------------------------------------ */

  private cloneAnnotation(annotation: OverlayAnnotation): OverlayAnnotation {
    return {
      note: annotation.note,
      target:
        annotation.target.kind === "section"
          ? { kind: "section" }
          : {
              kind: "line",
              row: annotation.target.row,
              context: annotation.target.context,
              contextTruncated: annotation.target.contextTruncated,
            },
    };
  }

  private pushUndo(): void {
    this.undo.push({
      text: joinPlanSections(this.sections),
      annotations: this.sections.map((section) =>
        section.annotations.map((annotation) => this.cloneAnnotation(annotation)),
      ),
      deleted: [...this.deleted],
    });
  }

  private startSectionAnnotate(): void {
    const sectionIndex = this.toc[this.tocCursor];
    if (sectionIndex === undefined) return;
    this.startAnnotate({ sectionIndex, row: null, context: null });
  }

  private startBodyAnnotate(): void {
    const maxRow = this.bodyRowAnchors.length - 1;
    if (maxRow < 0) return;
    const topRow = Math.max(0, Math.min(maxRow, Math.floor(this.scroll)));
    this.startAnnotate(this.bodyRowAnchors[topRow]!);
  }

  private startAnnotate(target: BodyRowAnchor | { sectionIndex: number; row: null; context: null }): void {
    this.annotationTarget = target;
    this.annotating = true;
    this.input.setValue("");
  }

  private submitAnnotation(value: string): void {
    this.annotating = false;
    const note = value.trim();
    const target = this.annotationTarget;
    this.annotationTarget = undefined;
    const section = target ? this.sections[target.sectionIndex] : undefined;
    if (note && section && target) {
      this.pushUndo();
      section.annotations.push({
        note,
        target:
          target.row === null
            ? { kind: "section" }
            : {
                kind: "line",
                row: target.row,
                context: target.context,
                contextTruncated: target.contextTruncated,
              },
      });
      this.bodyCache = undefined;
      this.recomputeFeedback();
    }
    this.input.setValue("");
  }

  private exitAnnotate(): void {
    this.annotating = false;
    this.annotationTarget = undefined;
    this.input.setValue("");
  }

  private deleteSelectedSection(): void {
    const sectionIndex = this.toc[this.tocCursor];
    if (sectionIndex === undefined) return;
    const span = sectionDeletionSpan(this.sections, sectionIndex);
    if (span.length === 0) return;
    this.pushUndo();
    // Record the removed headings so the Refine feedback can ask the model to
    // drop them, then splice from the bottom up so earlier indices stay valid.
    for (const i of span) {
      const section = this.sections[i]!;
      if (section.level >= 1 && section.title) this.deleted.push(section.title);
    }
    for (let i = span.length - 1; i >= 0; i--) this.sections.splice(span[i]!, 1);
    this.rebuildToc();
    this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
    this.pendingScrollToToc = true;
    this.bodyCache = undefined;
    this.onPlanEdited?.(joinPlanSections(this.sections));
    this.recomputeFeedback();
  }

  private undoLast(): void {
    const entry = this.undo.pop();
    if (!entry) return;
    this.setSections(entry.text);
    for (let i = 0; i < this.sections.length; i++) {
      this.sections[i]!.annotations =
        entry.annotations[i]?.map((annotation) => this.cloneAnnotation(annotation)) ?? [];
    }
    this.deleted = [...entry.deleted];
    this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
    this.pendingScrollToToc = true;
    this.onPlanEdited?.(joinPlanSections(this.sections));
    this.recomputeFeedback();
  }

  private recomputeFeedback(): void {
    const annotated = this.sections.filter((section) => section.annotations.length > 0);
    if (annotated.length === 0 && this.deleted.length === 0) {
      this.onFeedbackChange?.("");
      return;
    }
    let feedback = "Refinement feedback on the plan:\n";
    if (this.deleted.length > 0) {
      feedback += "\nRemove these sections:\n";
      for (const title of this.deleted) feedback += `- ${title}\n`;
    }
    for (const section of annotated) {
      feedback += `\n## ${section.title || "Plan preamble"}\n`;
      for (const annotation of section.annotations) {
        if (annotation.target.kind === "line") feedback += `> Line: ${annotation.target.context}\n`;
        feedback += this.formatAnnotationFeedback(annotation.note);
      }
    }
    this.onFeedbackChange?.(feedback);
  }

  private formatAnnotationFeedback(note: string): string {
    if (!note.includes("\n")) return `- ${note}\n`;
    const fence = this.markdownFenceFor(note);
    return `${fence}md\n${note}\n${fence}\n`;
  }

  private markdownFenceFor(text: string): string {
    let fence = "```";
    while (text.includes(fence)) fence += "`";
    return fence;
  }

  /* ------------------------------------------------------------
   * Input
   * ------------------------------------------------------------ */

  handleInput(data: string): void {
    if (this.annotating) {
      this.input.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    if (this.onCopyPlan && data === "c") {
      this.onCopyPlan(joinPlanSections(this.sections));
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleRegion(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.cycleRegion(-1);
      return;
    }
    switch (this.focus) {
      case "actions":
        this.handleActions(data);
        return;
      case "body":
        this.handleBody(data);
        return;
      case "toc":
        this.handleToc(data);
        return;
    }
  }

  private handleActions(data: string): void {
    // No slider in this port: left/right are inert (omp only binds them with a
    // model-tier slider), so region stepping uses h/l + the sidebar via Tab.
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) return;
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.selectedIndex === this.firstEnabledIndex()) this.setFocus("body");
      else this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || data === "\n") {
      this.confirmSelection();
      return;
    }
    this.handleBodyScroll(data);
  }

  private handleBody(data: string): void {
    if (data === "a") {
      this.startBodyAnnotate();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
      if (this.sidebarShown) this.setFocus("toc");
      return;
    }
    if (
      matchesKey(data, Key.right) ||
      matchesKey(data, "l") ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return) ||
      data === "\n"
    ) {
      this.setFocus("actions");
      return;
    }
    // Vertical nav flows between regions at the edges: scrolling off the bottom
    // drops into the actions, scrolling off the top steps back up to the ToC.
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.scroll <= 0 && this.sidebarShown) {
        this.setFocus("toc");
      } else {
        this.scroll -= 1;
        this.clampScroll();
        this.captureScrollProgress();
      }
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.scroll >= this.maxScroll()) {
        this.setFocus("actions");
      } else {
        this.scroll += 1;
        this.clampScroll();
        this.captureScrollProgress();
      }
      return;
    }
    this.handleBodyScroll(data);
  }

  private handleToc(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.moveTocCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      // Past the last section, fall through to the actions.
      if (this.tocCursor >= this.toc.length - 1) this.setFocus("actions");
      else this.moveTocCursor(1);
      return;
    }
    if (
      matchesKey(data, Key.right) ||
      matchesKey(data, "l") ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return) ||
      data === "\n"
    ) {
      this.setFocus("body");
      return;
    }
    if (data === "d" || matchesKey(data, Key.delete)) {
      this.deleteSelectedSection();
      return;
    }
    if (data === "a") {
      this.startSectionAnnotate();
      return;
    }
    if (data === "u") {
      this.undoLast();
      return;
    }
  }

  /** Shared scroll dispatch for body + actions focus: paging, ends, vim g/G. */
  private handleBodyScroll(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scroll -= this.regionRows();
      this.clampScroll();
      this.captureScrollProgress();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scroll += this.regionRows();
      this.clampScroll();
      this.captureScrollProgress();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scroll = 0;
      this.scrollProgress = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scroll = this.maxScroll();
      this.scrollProgress = 1;
      return;
    }
    if (matchesKey(data, Key.shift("up"))) {
      this.scroll -= 3;
      this.clampScroll();
      this.captureScrollProgress();
      return;
    }
    if (matchesKey(data, Key.shift("down"))) {
      this.scroll += 3;
      this.clampScroll();
      this.captureScrollProgress();
      return;
    }
    if (data === "g") {
      this.scroll = 0;
      this.scrollProgress = 0;
    } else if (data === "G") {
      this.scroll = this.maxScroll();
      this.scrollProgress = 1;
    }
  }

  /* ------------------------------------------------------------
   * Body rendering
   * ------------------------------------------------------------ */

  private buildBody(contentWidth: number): BodyCache {
    if (this.bodyCache && this.bodyCache.width === contentWidth) return this.bodyCache;
    const lines: string[] = [];
    const anchors: BodyRowAnchor[] = [];
    const offsets: number[] = new Array(this.sections.length);
    for (let sectionIndex = 0; sectionIndex < this.sections.length; sectionIndex++) {
      const section = this.sections[sectionIndex]!;
      offsets[sectionIndex] = lines.length;
      const rendered = section.md.render(contentWidth);
      const contexts = rendered.map((line) => this.lineContext(line));
      for (let row = 0; row < rendered.length; row++) {
        const context = contexts[row]!;
        const anchor: BodyRowAnchor = {
          sectionIndex,
          row,
          context: context.text,
          contextTruncated: context.truncated,
        };
        lines.push(rendered[row]!);
        anchors.push(anchor);
        for (const annotation of section.annotations) {
          const annotationRow =
            annotation.target.kind === "section"
              ? 0
              : this.resolveLineRow(
                  annotation.target.row,
                  { text: annotation.target.context, truncated: annotation.target.contextTruncated },
                  contexts,
                );
          if (annotationRow === row) this.appendAnnotationCallout(lines, anchors, annotation.note, anchor, contentWidth);
        }
      }
    }
    this.bodyCache = { width: contentWidth, lines, anchors, offsets };
    return this.bodyCache;
  }

  private lineContext(line: string): LineAnchorContext {
    const sanitized = plainText(line);
    const truncated = visibleWidth(sanitized) > MAX_ANNOTATION_CONTEXT_WIDTH;
    const text = truncateToWidth(sanitized, MAX_ANNOTATION_CONTEXT_WIDTH, "…");
    return { text: text || "(blank line)", truncated };
  }

  private resolveLineRow(
    storedRow: number,
    storedContext: LineAnchorContext,
    contexts: readonly LineAnchorContext[],
  ): number {
    if (contexts.length === 0) return -1;
    const targetRow = Math.max(0, Math.floor(storedRow));
    const normalize = (context: LineAnchorContext): string => {
      const normalized = plainText(context.text).replace(/\s+/g, " ").trim();
      return context.truncated && normalized.endsWith("…") ? normalized.slice(0, -1) : normalized;
    };
    const normalizedStoredContext = normalize(storedContext);
    if (!normalizedStoredContext) return -1;
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let row = 0; row < contexts.length; row++) {
      const normalizedContext = normalize(contexts[row]!);
      if (
        normalizedContext !== normalizedStoredContext &&
        !normalizedContext.includes(normalizedStoredContext) &&
        !normalizedStoredContext.includes(normalizedContext)
      ) {
        continue;
      }
      const distance = Math.abs(row - targetRow);
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    return best;
  }

  private appendAnnotationCallout(
    lines: string[],
    anchors: BodyRowAnchor[],
    note: string,
    anchor: BodyRowAnchor,
    bodyContentWidth: number,
  ): void {
    const noteLines = note.split(/\r?\n/);
    for (let i = 0; i < noteLines.length; i++) {
      const prefix =
        i === 0
          ? `${this.theme.fg("warning", "▎ ")}${this.theme.fg("dim", "note: ")}`
          : `${this.theme.fg("warning", "▎ ")}${this.theme.fg("dim", "      ")}`;
      const available = Math.max(0, bodyContentWidth - visibleWidth(prefix));
      const displayLine = truncateToWidth(plainText(noteLines[i] ?? ""), available, "…");
      lines.push(truncateToWidth(`${prefix}${this.theme.fg("accent", displayLine)}`, bodyContentWidth));
      anchors.push(anchor);
    }
  }

  /* ------------------------------------------------------------
   * Render helpers
   * ------------------------------------------------------------ */

  private sidebarWidthFor(width: number): number {
    return Math.max(18, Math.min(30, Math.round(width * 0.24)));
  }

  private sidebarVisible(width: number): boolean {
    if (this.toc.length < SIDEBAR_MIN_HEADINGS) return false;
    if (width < SIDEBAR_MIN_TOTAL_WIDTH) return false;
    return splitBodyWidth(width, this.sidebarWidthFor(width)) >= SIDEBAR_MIN_BODY_WIDTH;
  }

  private renderSidebarLines(regionRows: number, sidebarWidth: number): string[] {
    const lines: string[] = [];
    const slots = Math.max(0, regionRows);
    const total = this.toc.length;
    let start = 0;
    if (total > slots) {
      start = Math.max(0, Math.min(this.tocCursor - Math.floor(slots / 2), total - slots));
    }
    for (let r = 0; r < slots; r++) {
      const p = start + r;
      lines.push(p < total ? this.renderTocEntry(p, sidebarWidth) : "");
    }
    return lines;
  }

  private renderTocEntry(p: number, width: number): string {
    const section = this.sections[this.toc[p]!]!;
    const highlighted = p === this.tocCursor;
    const selected = highlighted && this.focus === "toc";
    const glow = highlighted && this.focus !== "toc";
    // Compact rows: a single-column gutter, one space of indent per nesting
    // level, then the title and an annotation marker.
    const indent = " ".repeat(Math.max(0, section.level - this.tocBaseLevel));
    const ann = section.annotations.length > 0 ? " ✎" : "";
    const avail = Math.max(0, width - 1 - indent.length - visibleWidth(ann));
    const title = truncateToWidth(section.title || "(untitled)", avail, "…");
    const body = indent + title + ann;
    const gutter = selected ? "›" : glow ? "▎" : " ";
    const line = gutter + body;
    if (selected) return this.theme.bg("selectedBg", this.theme.bold(fit(line, width)));
    if (glow) return this.theme.fg("accent", line);
    return this.theme.fg("muted", line);
  }

  private renderOptionLines(): string[] {
    const active = this.focus === "actions";
    return this.options.map((label, i) => {
      const selected = i === this.selectedIndex;
      const isDisabled = this.disabled.has(i);
      // The cursor marks the selected option; it dims when actions are not the
      // focused region so the active region's highlight stays unambiguous.
      const cursor = selected ? this.theme.fg(active ? "accent" : "dim", CURSOR) : "  ";
      const text = isDisabled
        ? this.theme.fg("dim", label)
        : selected && active
          ? this.theme.bold(this.theme.fg("accent", label))
          : this.theme.fg("text", label);
      return cursor + text;
    });
  }

  private buildHelp(): string {
    const parts: string[] = [];
    switch (this.focus) {
      case "actions":
        parts.push("↑↓ select", "⏎ confirm");
        break;
      case "toc":
        parts.push("↑↓ section", "⏎ open", "a annotate", "d delete", "u undo");
        break;
      case "body":
        parts.push("↑↓ scroll", "⇧ faster", "pgup/pgdn", "g/G ends", "a annotate");
        break;
    }
    if (this.onCopyPlan) parts.push("c copy");
    parts.push("tab regions");
    parts.push(this.helpSuffix);
    return parts.join(" · ");
  }

  private renderFooterLines(innerWidth: number): string[] {
    if (this.annotating) {
      const target = this.annotationTarget;
      const section = target ? this.sections[target.sectionIndex] : undefined;
      const title = section?.title || "Plan preamble";
      const context =
        target && target.row !== null
          ? ` · ${truncateToWidth(target.context, Math.max(1, innerWidth - 16), "…")}`
          : "";
      const caption = truncateToWidth(
        `${this.theme.fg("dim", "Annotate")} ${this.theme.fg("accent", `‹${title}›${context}`)}`,
        innerWidth,
        "…",
      );
      return [caption, this.input.render(innerWidth)[0] ?? "", this.theme.fg("dim", "enter save · esc cancel")];
    }
    return [this.theme.fg("dim", this.buildHelp())];
  }

  /* ------------------------------------------------------------
   * Render
   * ------------------------------------------------------------ */

  render(width: number): string[] {
    const termHeight = (process.stdout as { rows?: number }).rows ?? 40;
    const sidebarShown = this.sidebarVisible(width);
    this.sidebarShown = sidebarShown;
    const sidebarWidth = sidebarShown ? this.sidebarWidthFor(width) : 0;
    const innerWidth = Math.max(1, width - 4);
    const bodyContentWidth = sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;

    const promptLines = [this.theme.bold(this.theme.fg("accent", this.promptTitle))];
    const metaLines = this.meta.map((line) => this.theme.fg("dim", line));
    const optionLines = this.renderOptionLines();
    const footerLines = this.renderFooterLines(innerWidth);

    // Chrome rows: top border, two dividers, bottom border, plus the
    // prompt/meta/option/footer rows between them.
    const chrome = 4 + promptLines.length + metaLines.length + optionLines.length + footerLines.length;
    const regionRows = Math.max(MIN_BODY_ROWS, termHeight - chrome);

    const body = this.buildBody(bodyContentWidth);
    this.sectionOffsets = body.offsets;
    this.bodyRowAnchors = body.anchors;
    this.layoutBody(body.lines, regionRows);
    if (this.pendingScrollToToc) {
      this.pendingScrollToToc = false;
      this.scrubBodyToToc();
    }
    if (this.focus !== "toc") this.tocCursor = this.deriveTocCursorFromScroll();

    const win = this.scroll;
    const out: string[] = [];
    if (sidebarShown) {
      const sidebar = this.renderSidebarLines(regionRows, sidebarWidth);
      out.push(topBorderSplit(this.theme, width, OVERLAY_TITLE, sidebarWidth));
      for (let i = 0; i < regionRows; i++) {
        out.push(splitRow(this.theme, sidebar[i] ?? "", body.lines[win + i] ?? "", width, sidebarWidth));
      }
      out.push(dividerSplit(this.theme, width, sidebarWidth));
    } else {
      out.push(topBorder(this.theme, width, OVERLAY_TITLE));
      for (let i = 0; i < regionRows; i++) {
        out.push(row(this.theme, body.lines[win + i] ?? "", width));
      }
      out.push(divider(this.theme, width));
    }
    for (const line of promptLines) out.push(row(this.theme, line, width));
    for (const line of metaLines) out.push(row(this.theme, line, width));
    for (const line of optionLines) out.push(row(this.theme, line, width));
    out.push(divider(this.theme, width));
    for (const line of footerLines) out.push(row(this.theme, line, width));
    out.push(bottomBorder(this.theme, width));
    return out;
  }
}

export interface PlanViewOptions {
  /** Plan title; rendered as omp's `promptTitle` above the options. */
  title: string;
  /** Explicit prompt title override (defaults to `title`). */
  promptTitle?: string;
  /** Dim info lines under the prompt title (e.g. artifact path). */
  meta?: string[];
  planText: string;
  /** Approval options rendered in the always-visible action bar. */
  actions: string[];
  /** Indices into `actions` that render dimmed and cannot be selected. */
  disabledIndices?: number[];
  /** Initially highlighted option index. */
  initialIndex?: number;
  /** Trailing footer hint (defaults to `esc cancel`). */
  helpText?: string;
  /** Called with the full plan text when `c` is pressed. */
  onCopyPlan?: (content: string) => void;
  /** Called with the new full plan text after an in-overlay delete/undo. */
  onPlanEdited?: (content: string) => void;
  /** Called with the Refine feedback markdown whenever annotations change. */
  onFeedbackChange?: (feedback: string) => void;
}

/**
 * Show the plan review overlay.
 *
 * Resolves with the chosen action label, or null on escape/cancel.
 */
export async function showPlanView(
  ctx: ExtensionContext,
  options: PlanViewOptions,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const view = new PlanReviewView(theme, options);
      view.onPick = (option) => done(option);
      view.onCancel = () => done(null);
      view.onCopyPlan = options.onCopyPlan;
      view.onPlanEdited = options.onPlanEdited;
      view.onFeedbackChange = options.onFeedbackChange;
      return {
        render: (width: number) => view.render(width),
        invalidate: () => view.invalidate(),
        handleInput: (data: string) => {
          view.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );
}

export { extractPlanTitle };
