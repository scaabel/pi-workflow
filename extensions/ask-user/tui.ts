/**
 * TUI dialog for ask_user, built on ctx.ui.custom(). Forked from the
 * examples/extensions/question.ts render loop, extended with:
 *   - recommended option marker (★ recommended)
 *   - multi-select (space toggles, "✓ Done" to confirm)
 *   - "Chat…" escape hatch
 *   - free-text / multiline via the in-component Editor
 */
import { Editor, Key, matchesKey, type EditorTheme, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskOption, AskUserParams, AskUserResult } from "./types";

type Entry =
  | { kind: "opt"; option: AskOption; value: string; optIndex: number }
  | { kind: "other" }
  | { kind: "chat" }
  | { kind: "done" };

function makeEditorTheme(theme: ExtensionContext["ui"]["theme"]): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

export async function tuiAsk(params: AskUserParams, ctx: ExtensionContext): Promise<AskUserResult> {
  const opts = params.options ?? [];
  const allowOther = params.allowOther !== false;
  const questionId = params.id;
  const multi = params.multi === true;

  if (opts.length === 0) {
    return freeText(params.question, questionId, ctx);
  }

  const entries: Entry[] = opts.map((o, i) => ({
    kind: "opt",
    option: o,
    value: o.value ?? o.label,
    optIndex: i,
  }));
  if (allowOther) entries.push({ kind: "other" });
  if (multi) entries.push({ kind: "done" });
  entries.push({ kind: "chat" });

  const result = await ctx.ui.custom<AskUserResult | null>((tui, theme, _kb, done) => {
    let cursor = 0;
    const selected = new Set<number>(); // indices into opts
    let editMode = false;
    let cachedLines: string[] | undefined;

    const editor = new Editor(tui, makeEditorTheme(theme));

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function toggle(i: number) {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
    }

    function confirmDone() {
      if (selected.size === 0) return;
      const values = [...selected]
        .sort((a, b) => a - b)
        .map((i) => opts[i]!.value ?? opts[i]!.label);
      done({ kind: "answer", questionId, selected: values });
    }

    editor.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        editMode = false;
        editor.setText("");
        refresh();
        return;
      }
      done({ kind: "other", questionId, customInput: trimmed });
    };

    function handleInput(data: string) {
      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          editMode = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      if (matchesKey(data, Key.up)) {
        cursor = (cursor - 1 + entries.length) % entries.length;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        cursor = (cursor + 1) % entries.length;
        refresh();
        return;
      }

      const entry = entries[cursor];

      if (matchesKey(data, Key.enter)) {
        if (!entry) return;
        if (entry.kind === "opt") {
          if (multi) {
            toggle(entry.optIndex);
            refresh();
          } else {
            done({ kind: "answer", questionId, selected: [entry.value] });
          }
          return;
        }
        if (entry.kind === "other") {
          editMode = true;
          editor.setText("");
          refresh();
          return;
        }
        if (entry.kind === "chat") {
          done({ kind: "chat", questionId });
          return;
        }
        if (entry.kind === "done") {
          confirmDone();
        }
        return;
      }

      if (matchesKey(data, Key.space) && multi && entry && entry.kind === "opt") {
        toggle(entry.optIndex);
        refresh();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        done(null);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const rw = Math.max(1, width);
      const add = (t: string) => lines.push(...wrapTextWithAnsi(t, rw));
      const addPrefixed = (prefix: string, text: string) => {
        const pw = visibleWidth(prefix);
        if (pw >= rw) {
          add(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, rw - pw);
        const cont = " ".repeat(pw);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
        }
      };

      lines.push(theme.fg("accent", "─".repeat(rw)));
      addPrefixed(" ", theme.fg("text", params.question));
      lines.push("");

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const isCursor = i === cursor;
        const cursorPrefix = isCursor ? theme.fg("accent", "> ") : "  ";

        if (e.kind === "opt") {
          let mark = "";
          if (multi) {
            mark = selected.has(e.optIndex)
              ? theme.fg("accent", "[x] ")
              : theme.fg("muted", "[ ] ");
          }
          let label = `${i + 1}. ${e.option.label}`;
          if (e.option.recommended) label += theme.fg("muted", "  ★ recommended");
          const color = isCursor || e.option.recommended ? "accent" : "text";
          addPrefixed(cursorPrefix, mark + theme.fg(color, label));
          if (e.option.description) {
            addPrefixed("     ", theme.fg("muted", e.option.description));
          }
        } else if (e.kind === "other") {
          const label = `${i + 1}. Other… (type your own answer)${editMode ? " ✎" : ""}`;
          addPrefixed(cursorPrefix, theme.fg(isCursor ? "accent" : "muted", label));
        } else if (e.kind === "chat") {
          const label = `${i + 1}. Chat… (switch to free-form conversation)`;
          addPrefixed(cursorPrefix, theme.fg(isCursor ? "accent" : "muted", label));
        } else if (e.kind === "done") {
          const canDone = selected.size > 0;
          addPrefixed(
            cursorPrefix,
            theme.fg(isCursor ? "accent" : canDone ? "success" : "dim", "✓ Done"),
          );
        }
      }

      if (editMode) {
        lines.push("");
        addPrefixed(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, rw - 2))) {
          lines.push(` ${line}`);
        }
      }

      lines.push("");
      if (editMode) {
        addPrefixed(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
      } else if (multi) {
        addPrefixed(" ", theme.fg("dim", "↑↓ move • space toggle • Enter confirm • Esc cancel"));
      } else {
        addPrefixed(" ", theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
      }
      lines.push(theme.fg("accent", "─".repeat(rw)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });

  return result ?? { kind: "cancelled", questionId };
}

async function freeText(question: string, questionId: string, ctx: ExtensionContext): Promise<AskUserResult> {
  const result = await ctx.ui.custom<{ text: string } | null>((tui, theme, _kb, done) => {
    let cachedLines: string[] | undefined;
    const editor = new Editor(tui, makeEditorTheme(theme));

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    editor.onSubmit = (value) => {
      const t = value.trim();
      if (t) done({ text: t });
    };

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }
      editor.handleInput(data);
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const rw = Math.max(1, width);
      lines.push(theme.fg("accent", "─".repeat(rw)));
      lines.push(...wrapTextWithAnsi(theme.fg("text", question), rw));
      lines.push("");
      lines.push(theme.fg("muted", "Your answer:"));
      for (const line of editor.render(Math.max(1, rw - 2))) {
        lines.push(` ${line}`);
      }
      lines.push("");
      lines.push(theme.fg("dim", "Enter to submit • Esc to cancel"));
      lines.push(theme.fg("accent", "─".repeat(rw)));
      cachedLines = lines;
      return lines;
    }

    return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
  });

  if (!result) return { kind: "cancelled", questionId };
  return { kind: "answer", questionId, selected: [result.text], customInput: result.text };
}
