/**
 * Dependency-free self-check for the ask_user RPC logic.
 * Run with: bun selfcheck.ts
 */
import { rpcAsk, unavailableResult } from "./dialog";
import type { AskUserParams } from "./types";

class FakeUI {
  selectCalls: string[][] = [];
  confirmCalls: string[] = [];
  inputCalls: string[] = [];
  private _selects: (string | undefined)[] = [];
  private _confirms: boolean[] = [];
  private _inputs: (string | undefined)[] = [];

  selectResponses(...r: (string | undefined)[]) { this._selects = r; return this; }
  confirmResponses(...r: boolean[]) { this._confirms = r; return this; }
  inputResponses(...r: (string | undefined)[]) { this._inputs = r; return this; }

  async select(title: string, options: string[]) { this.selectCalls.push(options); return this._selects.shift(); }
  async confirm(title: string, message: string) { this.confirmCalls.push(message); return this._confirms.shift() ?? false; }
  async input(title: string, _placeholder?: string) { this.inputCalls.push(title); return this._inputs.shift(); }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const single: AskUserParams = {
  id: "recurrence",
  question: "How should recurrence be modeled?",
  options: [
    { label: "Separate model", recommended: true },
    { label: "On Expense", description: "Simpler but mixes concerns" },
  ],
};

async function main() {
  // Single-select recommended answer.
  {
    const f = new FakeUI().selectResponses("Separate model (recommended)");
    const r = await rpcAsk(single, f);
    assert(r.kind === "answer", "single: kind=answer");
    assert(r.kind === "answer" && r.selected[0] === "Separate model", "single: maps value");
    assert(f.selectCalls.length === 1, "single: one select call");
  }

  // Single-select → Other… → custom input (trimmed).
  {
    const f = new FakeUI().selectResponses("Other… (type a custom answer)").inputResponses("  custom idea  ");
    const r = await rpcAsk(single, f);
    assert(r.kind === "other", "other: kind=other");
    assert(r.kind === "other" && r.customInput === "custom idea", "other: trims input");
  }

  // Single-select → Chat… escape.
  {
    const f = new FakeUI().selectResponses("Chat… (switch to free-form conversation)");
    const r = await rpcAsk(single, f);
    assert(r.kind === "chat", "chat: kind=chat");
  }

  // Single-select cancelled (undefined).
  {
    const f = new FakeUI().selectResponses(undefined);
    const r = await rpcAsk(single, f);
    assert(r.kind === "cancelled", "cancelled: select undefined");
  }

  // Multi-select: first option on, second off; other/chat declined.
  {
    const f = new FakeUI().confirmResponses(true, false);
    const r = await rpcAsk({ ...single, multi: true }, f);
    assert(r.kind === "answer", "multi: kind=answer");
    assert(r.kind === "answer" && r.selected.length === 1 && r.selected[0] === "Separate model", "multi: selected set");
  }

  // Free text (no options).
  {
    const f = new FakeUI().inputResponses("hello");
    const r = await rpcAsk({ id: "q", question: "Anything else?" }, f);
    assert(r.kind === "answer" && r.selected[0] === "hello", "free text");
  }

  // Unavailable result carries the recommended option.
  {
    const r = unavailableResult(single);
    assert(r.kind === "unavailable", "unavailable: kind");
    assert(r.kind === "unavailable" && r.recommended === "Separate model", "unavailable: recommended");
  }

  console.log("ask_user selfcheck: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
