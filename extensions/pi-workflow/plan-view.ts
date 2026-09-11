/**
 * Split-pane plan review view.
 *
 * Left (~30%): main context (title, meta) on top, then the plan
 * breakdown (outline parsed from headings). Right (~70%): the full
 * plan rendered as Markdown, scrollable. Beneath the panes sits the
 * always-visible approval action bar.
 *
 * Focus regions (`outline` / `plan` / `actions`) cycle with
 * Tab/Shift+Tab (or ←/→). Arrows move within the focused region and
 * flow between regions at the edges: scrolling off the bottom of the
 * plan drops into the action bar, and the top steps back into the
 * outline. The default focus is `actions`, so ↑/↓ pick between the
 * options and Enter confirms the highlighted one.
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

/** Cap for the plan-pane viewport; the live value shrinks to fit the terminal. */
const MAX_VIEWPORT = 32;

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

type Focus = "outline" | "plan" | "actions";

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
  public onPick?: (option: string) => void;
  public onCancel?: () => void;

  private readonly theme: ViewTheme;

  private readonly outline: OutlineSection[];

  private readonly title: string;

  private readonly meta: string[];

  private readonly options: string[];

  private mdTheme =
    getMarkdownTheme();

  private cacheWidth?: number;

  private cache?: {
    sections: RenderedSection[];
    lines: string[];
  };

  private scroll = 0;

  private focus: Focus = "actions";

  private selectedOption = 0;

  private selected = 0;

  private active = 0;

  constructor(
    theme: ViewTheme,
    options: PlanViewOptions,
  ) {
    this.theme = theme;
    this.title = options.title;
    this.meta = options.meta ?? [];
    this.options =
      options.actions.length > 0
        ? options.actions
        : ["Approve", "Cancel"];
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

  /**
   * Plan-pane rows after reserving the action bar + footer. Shrinks on
   * short terminals so the approval options stay visible.
   */
  private get viewport(): number {
    const rows =
      (process.stdout as { rows?: number }).rows ?? 40;

    const reserved =
      this.options.length + 7;

    return Math.max(
      6,
      Math.min(
        MAX_VIEWPORT,
        rows - reserved,
      ),
    );
  }

  private maxScroll(): number {
    return Math.max(
      0,

      (this.cache
        ?.lines.length ??
        0) -
        this.viewport,
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

  private cycleFocus(dir: number): void {
    const order: Focus[] = [
      "outline",
      "plan",
      "actions",
    ];

    const i =
      order.indexOf(this.focus);

    this.focus =
      order[
        (i +
          dir +
          order.length) %
          order.length
      ]!;
  }

  private moveOption(delta: number): void {
    this.selectedOption =
      Math.max(
        0,

        Math.min(
          this.options.length - 1,
          this.selectedOption + delta,
        ),
      );
  }

  private confirmOption(): void {
    const option =
      this.options[this.selectedOption];

    if (option) {
      this.onPick?.(option);
    }
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
        Key.tab,
      )
    ) {
      this.cycleFocus(1);

      return;
    }

    if (
      matchesKey(
        data,
        Key.shift("tab"),
      )
    ) {
      this.cycleFocus(-1);

      return;
    }

    if (
      matchesKey(
        data,
        Key.left,
      )
    ) {
      this.cycleFocus(-1);

      return;
    }

    if (
      matchesKey(
        data,
        Key.right,
      )
    ) {
      this.cycleFocus(1);

      return;
    }

    if (
      matchesKey(
        data,
        Key.pageUp,
      )
    ) {
      this.scroll -=
        this.viewport;

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
        this.viewport;

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
      this.focus ===
      "actions"
    ) {
      if (
        matchesKey(
          data,
          Key.enter,
        )
      ) {
        this.confirmOption();

        return;
      }

      if (
        matchesKey(
          data,
          Key.up,
        )
      ) {
        this.moveOption(-1);

        return;
      }

      if (
        matchesKey(
          data,
          Key.down,
        )
      ) {
        this.moveOption(1);

        return;
      }

      return;
    }

    if (
      this.focus === "plan"
    ) {
      if (
        matchesKey(
          data,
          Key.enter,
        )
      ) {
        this.focus = "actions";

        return;
      }

      if (
        matchesKey(
          data,
          Key.up,
        )
      ) {
        if (this.scroll <= 0) {
          this.focus = "outline";
        } else {
          this.scroll -= 1;

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
          this.scroll >=
          this.maxScroll()
        ) {
          this.focus = "actions";
        } else {
          this.scroll += 1;

          this.clampScroll();
        }

        return;
      }

      return;
    }

    // outline
    if (
      matchesKey(
        data,
        Key.enter,
      )
    ) {
      this.focus = "plan";

      return;
    }

    if (
      matchesKey(
        data,
        Key.up,
      )
    ) {
      this.selectSection(
        this.selected -
          1,
      );

      return;
    }

    if (
      matchesKey(
        data,
        Key.down,
      )
    ) {
      const last =
        (this.cache?.sections
          .length ??
          1) - 1;

      if (
        this.selected >= last
      ) {
        this.focus = "actions";
      } else {
        this.selectSection(
          this.selected +
            1,
        );
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

    const vp = this.viewport;

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
          this.focus ===
            "outline" &&
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
        vp;
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
      vp;
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

    /*
     * Always-visible approval
     * action bar.
     */
    rows.push(
      "",
    );

    const actionsActive =
      this.focus === "actions";

    this.options.forEach(
      (
        option,
        index,
      ) => {
        const isSelected =
          index ===
          this.selectedOption;

        const prefix =
          isSelected
            ? this.theme.fg(
                "accent",
                "▸ ",
              )
            : "  ";

        const label =
          isSelected &&
          actionsActive
            ? this.theme.bold(
                this.theme.fg(
                  "accent",
                  option,
                ),
              )
            : this.theme.fg(
                isSelected
                  ? "accent"
                  : actionsActive
                    ? "text"
                    : "muted",
                option,
              );

        rows.push(
          truncateToWidth(
            prefix + label,
            width,
            "",
          ),
        );
      },
    );

    /*
     * Focus-aware footer help.
     */
    rows.push(
      "",
    );

    const hint =
      this.focus === "actions"
        ? "↑↓ select · enter confirm"
        : this.focus === "plan"
          ? "↑↓ scroll · enter actions"
          : "↑↓ section · enter plan";

    rows.push(
      truncateToWidth(
        this.theme.fg(
          "dim",

          `${hint} · tab focus · pgup/pgdn page · esc cancel`,
        ),
        width,
        "",
      ),
    );

    return rows;
  }
}

export interface PlanViewOptions {
  title: string;

  meta?: string[];

  planText: string;

  /** Approval options rendered in the always-visible action bar. */
  actions: string[];
}

/**
 * Show the plan review view.
 *
 * Resolves with the chosen action label, or null on escape/cancel.
 */
export async function showPlanView(
  ctx: ExtensionContext,
  options: PlanViewOptions,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
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

      view.onPick =
        (option) =>
          done(option);

      view.onCancel =
        () =>
          done(null);

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
