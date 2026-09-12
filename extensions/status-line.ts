/**
 * Catppuccin Mocha powerline status line (footer) — oh-my-pi style.
 *
 * Replaces pi's footer with a single powerline bar:
 *   [ branch] [ spinner/ready] ...... [tokens/cost/context] [ model]
 *
 * Nerd Font powerline separators + a braille spinner, colored with the
 * Catppuccin Mocha palette (mirrors themes/catppuccin-mocha.json).
 *
 * ponytail: one "full" preset, raw 24-bit ANSI for segment fills because
 * theme.bg() has no arbitrary segment-fill tokens. Presets/toggle YAGNI.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Catppuccin Mocha.
const C = {
	base: "#1e1e2e",
	surface0: "#313244",
	subtext1: "#bac2de",
	subtext0: "#a6adc8",
	text: "#cdd6f4",
	mauve: "#cba6f7",
	blue: "#89b4fa",
	green: "#a6e3a1",
	yellow: "#f9e2af",
	peach: "#fab387",
	red: "#f38ba8",
	overlay0: "#6c7086",
} as const;

// Thinking level -> {label, color} (colors mirror the theme's thinking tokens).
const THINK: Record<string, { label: string; color: string }> = {
	off: { label: "off", color: C.subtext0 },
	minimal: { label: "min", color: C.green },
	low: { label: "low", color: C.green },
	medium: { label: "med", color: C.yellow },
	high: { label: "high", color: "#d98545" },
	xhigh: { label: "xhi", color: C.red },
	max: { label: "max", color: C.red },
};

const RESET = "\x1b[0m";
const PL = "\ue0b0"; //  powerline separator (points right)
const BRANCH = "\ue0a0"; //  git branch
const ROBOT = "\uec20"; //  robot / model
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function rgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fg(hex: string): string {
	const [r, g, b] = rgb(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function bg(hex: string): string {
	const [r, g, b] = rgb(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

interface Seg {
	bg: string;
	fg: string;
	text: string;
}

function powerline(segs: Seg[]): string {
	let out = "";
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i]!;
		out += bg(s.bg) + fg(s.fg) + s.text;
		if (i < segs.length - 1) {
			out += bg(segs[i + 1]!.bg) + fg(s.bg) + PL;
		}
	}
	return out + RESET;
}

// Per-session state.
let working = false;
let tuiRef: TUI | null = null;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

function setWorking(value: boolean): void {
	working = value;
	if (value) {
		if (!spinnerTimer) {
			spinnerTimer = setInterval(() => tuiRef?.requestRender(), 100);
		}
	} else {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		tuiRef?.requestRender();
	}
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function paint(color: string, text: string, base = C.subtext1): string {
	return fg(color) + text + fg(base);
}

function ponyIcon(status: string | undefined): string | null {
	if (!status) return null;
	const plain = status.replace(/\x1b\[[0-9;]*m/g, "");
	if (/REVIEW/.test(plain)) return "👀";
	if (/LITE/.test(plain)) return "🌿";
	if (/FULL/.test(plain)) return "⚡";
	if (/ULTRA/.test(plain)) return "🔥";
	return null;
}

export default function statusLine(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		working = false;

		ctx.ui.setFooter((tui, _theme, footerData) => {
			tuiRef = tui;
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					tuiRef = null;
					setWorking(false);
				},
				invalidate() {},
				render(width: number): string[] {
					// Token + cost totals from assistant usage.
					let input = 0;
					let output = 0;
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const usage = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					const spinner = SPIN[Math.floor(Date.now() / 100) % SPIN.length]!;

					const pony = ponyIcon(footerData.getExtensionStatuses().get("ponytail"));
					const ponyText = pony ? `🐴${pony} ` : "";

					const status: Seg = working
						? { bg: C.surface0, fg: C.subtext1, text: ` ${ponyText}${spinner} working ` }
						: { bg: C.surface0, fg: C.green, text: ` ${ponyText} ready ` };

					const pct = usage?.percent != null ? `${usage.percent}%` : null;
					const tokensSeg: Seg = {
						bg: C.surface0,
						fg: C.subtext1,
						text:
							" " +
							paint(C.blue, `↑${fmt(input)}`) +
							" " +
							paint(C.green, `↓${fmt(output)}`) +
							" " +
							paint(C.yellow, `$${cost.toFixed(3)}`) +
							(pct ? ` · ${paint(C.peach, pct)}` : "") +
							" ",
					};
					const think = THINK[ctx.thinkingLevel ?? "off"] ?? THINK.off;
					const modelSeg: Seg = {
						bg: C.mauve,
						fg: C.base,
						text: ` ${ROBOT} ${ctx.model?.id || "no-model"} · ${paint(think.color, think.label, C.base)} `,
					};

					const left: Seg[] = [];
					if (branch) {
						left.push({ bg: C.mauve, fg: C.base, text: ` ${BRANCH} ${branch} ` });
					}
					left.push(status);

					const nonFiller = [...left, tokensSeg, modelSeg];
					let textW = 0;
					for (const s of nonFiller) textW += visibleWidth(s.text);
					const segCount = nonFiller.length + 1; // +1 for the filler segment
					const fillerW = width - textW - (segCount - 1);

					let finalSegs: Seg[];
					if (fillerW >= 1) {
						finalSegs = [
							...left,
							{ bg: C.base, fg: C.base, text: " ".repeat(fillerW) },
							tokensSeg,
							modelSeg,
						];
					} else {
						finalSegs = nonFiller;
					}

					return [truncateToWidth(powerline(finalSegs), width)];
				},
			};
		});
	});

	pi.on("turn_start", async () => setWorking(true));
	pi.on("agent_settled", async () => setWorking(false));
	pi.on("model_select", async () => tuiRef?.requestRender());
	pi.on("thinking_level_select", async () => tuiRef?.requestRender());
	pi.on("session_shutdown", async () => setWorking(false));
}
