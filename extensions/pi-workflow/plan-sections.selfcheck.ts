/**
 * Dependency-free self-check for the plan section parser.
 * Run with: bun extensions/pi-workflow/plan-sections.selfcheck.ts
 */
import {
  joinPlanSections,
  parsePlanSections,
  sectionDeletionSpan,
  stripInlineMarkdown,
} from "./plan-sections";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

function main() {
  // Preamble + two top-level headings round-trip byte-for-byte.
  {
    const text = "# Goal\none sentence\n\n## Findings\n- a\n- b\n\n## Steps\n1. x\n";
    const sections = parsePlanSections(text);
    assert(sections.length === 3, "round-trip: 3 sections");
    assert(sections[0]!.level === 1, "round-trip: no preamble, first section is heading");
    assert(sections[0]!.title === "Goal", "round-trip: heading title stripped");
    assert(joinPlanSections(sections) === text, "round-trip: join === input");
  }

  // `#` inside a fenced code block is NOT a heading.
  {
    const text = "Intro\n\n```\n# fake heading\n```\n\n## Real heading\nbody\n";
    const sections = parsePlanSections(text);
    assert(sections.length === 2, "fence: only 2 sections");
    assert(sections[0]!.title === "", "fence: preamble is intro");
    assert(sections[1]!.title === "Real heading", "fence: real heading captured");
    assert(joinPlanSections(sections) === text, "fence: join === input");
  }

  // Fence with language tag still opens; closing fence needs same char.
  {
    const text = "```ts\n# nope\n~~~\n```\n## Yep\n";
    const sections = parsePlanSections(text);
    assert(sections.length === 2, "fence-lang: 2 sections");
    assert(sections[1]!.title === "Yep", "fence-lang: last heading captured");
  }

  // Nested sub-headings are included in a deletion span, siblings are not.
  {
    const text = "# A\n## A1\n### A1a\n## B\n";
    const sections = parsePlanSections(text);
    assert(sections.length === 4, "span: 4 sections");
    assert(JSON.stringify(sectionDeletionSpan(sections, 1)) === "[1,2]", "span: deletes nested A1 + A1a");
    assert(JSON.stringify(sectionDeletionSpan(sections, 2)) === "[2]", "span: leaf deletes self");
  }

  // Preamble is never deletable.
  {
    const sections = parsePlanSections("intro line\n\n# A\nbody\n");
    assert(sections[0]!.level === 0, "preamble: level 0");
    assert(sectionDeletionSpan(sections, 0).length === 0, "span: preamble not deletable");
  }

  // stripInlineMarkdown collapses links/emphasis/code to readable text.
  {
    const s = stripInlineMarkdown("**Goal** & [docs](https://x) `code` _em_");
    assert(s === "Goal & docs code em", "strip: collapses markup");
  }

  // No trailing-newline input still joins with one trailing newline.
  {
    const sections = parsePlanSections("# A\nx");
    assert(joinPlanSections(sections).endsWith("\n"), "join: guarantees trailing newline");
  }

  console.log("plan-sections selfcheck: all passed");
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}