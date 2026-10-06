/**
 * Workflow role-model overrides for the subagent tool.
 *
 * The pi-workflow extension persists role models (planner/scout/executor/reviewer)
 * to ~/.pi/agent/workflow-overrides.json. That extension flips the *parent*
 * session model via activateRole() for planner/executor, but scout subagents run
 * in separate `pi` processes, so the subagent tool must read the persisted file
 * itself and apply the `scout` role override to the scout/web-scout agents.
 *
 * Dependency-free (node:fs/node:path + getAgentDir) so it can be unit-tested
 * standalone; the file path is injectable for the selfcheck.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RoleModelOverride {
	model: string;
	thinkingLevel?: string;
}

interface OverridesFile {
	version?: number;
	models?: Record<
		string,
		{ provider?: string; modelId?: string; thinkingLevel?: string } | null
	>;
}

/**
 * Agent name -> workflow role. Only scout-style agents are dispatched as
 * subagents with a workflow role model; planner/executor/reviewer are applied to
 * the parent session by the pi-workflow extension.
 *
 * ponytail: hardcoded map; extend to a frontmatter `role` field if more agents
 * get workflow roles.
 */
const AGENT_ROLE_MAP: Record<string, string> = {
	scout: "scout",
	"web-scout": "scout",
};

/**
 * Load workflow role overrides keyed by agent name.
 *
 * Returns an empty map when the file is missing or malformed, so subagents fall
 * back to their frontmatter model (or the parent session model) unchanged.
 */
export function loadRoleModelOverrides(
	file = path.join(getAgentDir(), "workflow-overrides.json"),
): Map<string, RoleModelOverride> {
	const out = new Map<string, RoleModelOverride>();

	let models: OverridesFile["models"] | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as OverridesFile;
		models = parsed?.version === 1 && parsed.models ? parsed.models : undefined;
	} catch {
		models = undefined;
	}

	if (!models) return out;

	for (const [agentName, role] of Object.entries(AGENT_ROLE_MAP)) {
		const ref = models[role];
		if (!ref || typeof ref !== "object" || !ref.provider || !ref.modelId) {
			continue;
		}
		out.set(agentName, {
			model: `${ref.provider}/${ref.modelId}`,
			...(ref.thinkingLevel ? { thinkingLevel: ref.thinkingLevel } : {}),
		});
	}

	return out;
}
