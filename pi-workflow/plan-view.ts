/**
 * Split-pane plan review view.
 *
 * Left (~30%): main context (title, meta) on top, then the plan
 * breakdown (outline parsed from headings). Right (~70%): the full
 * plan rendered as Markdown, scrollable. Scrolling the right pane
 * moves the left highlight; focusing the left pane (tab) turns
 * arrows into section jumps that scroll the right pane in sync.
 *
 * // ponytail: fixed VIEWPORT height (overlay maxHeight clips on
 * // short terminals). The pi-tui ScrollView/HStack layout engine
 * // only runs in fullscreen (alt-screen) mode, so this is a plain
 * // component that works in both modes.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const VIEWPORT = 32;

interface ViewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface OutlineSection {
  title: string;
  text: string;
}

interface RenderedSection {
  title: string;
  startLine: number;
}

export function extractPlanTitle(
  text: string,
  fallback: string,
): string {
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

  const heading =
    /^#{1,6}\s+(.+)$/m.exec(
      text,
    );

  if (heading?.[1]?.trim()) {
    return heading[1].trim();
  }

  return fallback;
}

function splitSections(
  markdown: string,
): OutlineSection[] {
  const sections: OutlineSection[] =
    [];

  let title: string | null =
    null;

  let buffer: string[] = [];

  const flush = () => {
    if (
      buffer.some(
        (line) =>
          line.trim(),
      )
    ) {
      sections.push(
        {
          title:
            title ??
            "(intro)",

          text:
            buffer.join(
              "\n",
            ),
        },
      );
    }

    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    const heading =
      /^#{1,6}\s+(.+)$/.exec(
        line,
      );

    if (heading) {
      flush();

      title =
        heading[1].trim();

      buffer = [
        line,
      ];

      continue;
    }

    buffer.push(
      line,
    );
  }

  flush();

  if (
    sections.length === 0
  ) {
    sections.push(
      {
        title:
          "(plan)",

        text:
          markdown,
      },
    );
  }

  return sections;
}

function padEnd(
  line: string,
  width: number,
): string {
  const current =
    visibleWidth(
      line,
    );

  if (
    current >= width
  ) {
    return truncateToWidth(
      line,
      width,
      "",
    );
  }

  return (
    line +
    " ".repeat(
      width -
        current,
    )
  );
}

class PlanReviewView {
  public onProceed?: () => void;
  public onCancel?: () => void;

  private readonly theme: ViewTheme;

  private readonly outline: OutlineSection[];

  private readonly title: string;

  private readonly meta: string[];

  private readonly proceedLabel: string;

  private mdTheme =
    getMarkdownTheme();

  private cacheWidth?: number;

  private cache?: {
    sections: RenderedSection[];
    lines: string[];
  };

  private scroll = 0;

  private focusLeft = false;

  private selected = 0;

  private active = 0;

  constructor(
    theme: ViewTheme,
    options: {
      title: string;
      meta?: string[];
      planText: string;
      proceedLabel?: string;
    },
  ) {
    this.theme = theme;
    this.title = options.title;
    this.meta = options.meta ?? [];
    this.proceedLabel =
      options.proceedLabel ??
      "approve";
    this.outline =
      splitSections(
        options.planText,
      );
  }

  invalidate(): void {
    this.cacheWidth =
      undefined;

    this.mdTheme =
      getMarkdownTheme();
  }

  private maxScroll(): number {
    return Math.max(
      0,

      (this.cache
        ?.lines.length ??
        0) -
        VIEWPORT,
    );
  }

  private clampScroll(): void {
    this.scroll = Math.max(
      0,

      Math.min(
        this.scroll,
        this.maxScroll(),
      ),
    );
  }

  private buildCache(
    rightWidth: number,
  ): void {
    const lines: string[] =
      [];

    const sections: RenderedSection[] =
      [];

    for (const section of this
      .outline) {
      const rendered =
        new Markdown(
          section.text,
          0,
          0,
          this.mdTheme,
        ).render(
          rightWidth,
        );

      sections.push(
        {
          title:
            section.title,

          startLine:
            lines.length,
        },
      );

      lines.push(
        ...rendered,
        "",
      );
    }

    lines.pop();

    this.cache = {
      sections,
      lines,
    };
  }

  private activeSectionFromScroll(): number {
    const sections =
      this.cache?.sections ??
      [];

    let active = 0;

    for (
      let i = 0;
      i <
      sections.length;
      i++
    ) {
      if (
        sections[i]!
        .startLine <=
        this.scroll
      ) {
        active = i;
      }
    }

    return active;
  }

  private selectSection(
    index: number,
  ): void {
    const sections =
      this.cache?.sections ??
      [];

    if (
      sections.length ===
      0
    ) {
      return;
    }

    this.selected = Math.max(
      0,

      Math.min(
        index,
        sections.length -
          1,
      ),
    );

    this.scroll =
      sections[this
        .selected]!
        .startLine;

    this.clampScroll();
  }

  handleInput(
    data: string,
  ): void {
    if (
      matchesKey(
        data,
        Key.escape,
      )
    ) {
      this.onCancel?.();

      return;
    }

    if (
      matchesKey(
        data,
        Key.enter,
      )
    ) {
      this.onProceed?.();

      return;
    }

    if (
      matchesKey(
        data,
        Key.tab,
      ) ||
      matchesKey(
        data,
        Key.left,
      ) ||
      matchesKey(
        data,
        Key.right,
      )
    ) {
      this.focusLeft =
        !this.focusLeft;

      return;
    }

    if (
      matchesKey(
        data,
        Key.pageUp,
      )
    ) {
      this.scroll -=
        VIEWPORT;

      this.clampScroll();

      return;
    }

    if (
      matchesKey(
        data,
        Key.pageDown,
      )
    ) {
      this.scroll +=
        VIEWPORT;

      this.clampScroll();

      return;
    }

    if (
      matchesKey(
        data,
        Key.home,
      )
    ) {
      this.scroll = 0;

      return;
    }

    if (
      matchesKey(
        data,
        Key.end,
      )
    ) {
      this.scroll =
        Number.MAX_SAFE_INTEGER;

      this.clampScroll();

      return;
    }

    if (
      matchesKey(
        data,
        Key.up,
      )
    ) {
      if (
        this.focusLeft
      ) {
        this.selectSection(
          this.selected -
            1,
        );
      } else {
        this.scroll -=
          1;

        this.clampScroll();
      }

      return;
    }

    if (
      matchesKey(
        data,
        Key.down,
      )
    ) {
      if (
        this.focusLeft
      ) {
        this.selectSection(
          this.selected +
            1,
        );
      } else {
        this.scroll += 1;

        this.clampScroll();
      }

      return;
    }
  }

  render(
    width: number,
  ): string[] {
    const leftWidth = Math.max(
      26,

      Math.floor(
        width *
          0.3,
      ),
    );

    const rightWidth = Math.max(
      10,

      width -
        leftWidth -
        3,
    );

    if (
      this.cacheWidth !==
      rightWidth
    ) {
      this.buildCache(
        rightWidth,
      );

      this.cacheWidth =
        rightWidth;
    }

    this.clampScroll();

    this.active =
      this.activeSectionFromScroll();

    /*
     * Left pane: main context on
     * top, breakdown below.
     */
    const left: string[] =
      [];

    left.push(
      truncateToWidth(
        this.theme.fg(
          "accent",

          this.theme.bold(
            this.title,
          ),
        ),
        leftWidth,
      ),
    );

    for (const line of this
      .meta) {
      left.push(
        truncateToWidth(
          this.theme.fg(
            "dim",
            line,
          ),
          leftWidth,
        ),
      );
    }

    left.push(
      "",
    );

    const sections =
      this.cache?.sections ??
      [];

    sections.forEach(
      (
        section,
        index,
      ) => {
        const isSelected =
          this.focusLeft &&
          index ===
            this.selected;

        const isActive =
          index ===
          this.active;

        const prefix =
          isSelected
            ? "▸ "
            : "  ";

        const color =
          isSelected
            ? "accent"
            : isActive
              ? "text"
              : "muted";

        left.push(
          truncateToWidth(
            prefix +
              this.theme.fg(
                color,
                section.title,
              ),
            leftWidth,
          ),
        );
      },
    );

    /*
     * Right pane: the plan,
     * sliced by scroll.
     */
    const right: string[] =
      [];

    for (
      let i = this.scroll;
      i <
      this.scroll +
        VIEWPORT;
      i++
    ) {
      right.push(
        this.cache?.lines[
          i
        ] ?? "",
      );
    }

    const divider =
      this.theme.fg(
        "border",
        " │ ",
      );

    const rows: string[] =
      [];

    for (
      let i = 0;
      i <
      VIEWPORT;
      i++
    ) {
      rows.push(
        padEnd(
          left[i] ?? "",
          leftWidth,
        ) +
          divider +
          truncateToWidth(
            right[i] ?? "",
            rightWidth,
            "",
          ),
      );
    }

    const focusHint =
      this.focusLeft
        ? "outline (↑↓ jump sections)"
        : "plan (↑↓ scroll)";

    rows.push(
      "",
    );

    rows.push(
      this.theme.fg(
        "dim",

        `tab switch pane (now: ${focusHint}) · pgup/pgdn page · enter ${this.proceedLabel} · esc cancel`,
      ),
    );

    return rows;
  }
}

export interface PlanViewOptions {
  title: string;

  meta?: string[];

  planText: string;

  /** Footer label for the enter key. */
  proceedLabel?: string;
}

/**
 * Show the plan review view.
 *
 * Returns true when the user pressed
 * enter (proceed), false on escape.
 */
export async function showPlanView(
  ctx: ExtensionContext,
  options: PlanViewOptions,
): Promise<boolean> {
  return ctx.ui.custom<boolean>(
    (
      tui,
      theme,
      _keybindings,
      done,
    ) => {
      const view =
        new PlanReviewView(
          theme,
          options,
        );

      view.onProceed =
        () =>
          done(
            true,
          );

      view.onCancel =
        () =>
          done(
            false,
          );

      return {
        render: (
          width: number,
        ) =>
          view.render(
            width,
          ),

        invalidate: () =>
          view.invalidate(),

        handleInput: (
          data: string,
        ) => {
          view.handleInput(
            data,
          );

          tui.requestRender();
        },
      };
    },

    {
      overlay: true,

      overlayOptions:
        {
          anchor:
            "top-left",

          width: "100%",

          maxHeight:
            "90%",
        },
    },
  );
}
