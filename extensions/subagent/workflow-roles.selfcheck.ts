/**
 * Dependency-free self-check for workflow role overrides in the subagent tool.
 * Run with: bun extensions/subagent/workflow-roles.selfcheck.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRoleModelOverrides } from "./workflow-roles";

function assert(cond: boolean, msg: string) {
	if (!cond) throw new Error("FAIL: " + msg);
}

function write(file: string, content: unknown) {
	fs.writeFileSync(file, JSON.stringify(content), "utf-8");
}

function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-wf-"));
	const file = path.join(dir, "workflow-overrides.json");

	try {
		// Missing file -> empty map.
		assert(loadRoleModelOverrides(file).size === 0, "missing file -> empty");

		// Valid file -> scout and web-scout both mapped with model + thinkingLevel.
		write(file, {
			version: 1,
			models: {
				scout: {
					provider: "opencode-go",
					modelId: "deepseek-v4.1-flash",
					thinkingLevel: "medium",
				},
			},
		});
		const loaded = loadRoleModelOverrides(file);
		assert(loaded.size === 2, "two agent entries mapped");
		assert(loaded.get("scout")?.model === "opencode-go/deepseek-v4.1-flash", "scout model");
		assert(loaded.get("scout")?.thinkingLevel === "medium", "scout thinking level");
		assert(loaded.get("web-scout")?.model === "opencode-go/deepseek-v4.1-flash", "web-scout model");

		// Wrong version -> empty.
		write(file, { version: 2, models: { scout: { provider: "p", modelId: "m" } } });
		assert(loadRoleModelOverrides(file).size === 0, "wrong version -> empty");

		// null scout ref -> empty.
		write(file, { version: 1, models: { scout: null } });
		assert(loadRoleModelOverrides(file).size === 0, "null scout ref -> empty");

		console.log("workflow-roles selfcheck: all passed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
