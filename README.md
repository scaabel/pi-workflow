# pi-workflow

Portable pi config: extensions, subagents, prompts, and settings. Clone on any machine, run `./install.sh`, and you have the same pi workflow.

## Quick start

```bash
git clone git@github.com:scaabel/pi-workflow.git ~/Projects/pi-workflow
cd ~/Projects/pi-workflow
./install.sh
```

That's it — the script is idempotent, safe to re-run.

## What it does

`install.sh` symlinks four paths into `~/.pi/agent/` and installs the pi packages listed in `settings.json`:

| Repo path | Symlinked to | What's in it |
|-----------|--------------|--------------|
| `extensions/` | `~/.pi/agent/extensions` | custom extensions (ask-user, learning, pi-workflow plan-mode, subagent, dashboard, web-search) |
| `agents/` | `~/.pi/agent/agents` | subagent definitions (assessor, planner, reviewer, scout, web-scout, worker) |
| `prompts/` | `~/.pi/agent/prompts` | prompt templates (implement, implement-and-review, scout-and-plan) |
| `settings.json` | `~/.pi/agent/settings.json` | theme, model defaults, enabled models, package list |

Because the config is symlinked into this repo, editing your workflow and committing it is one place — same as the dotfiles repo.

## Synced vs. not synced

**Synced here:** extensions, agents, prompts, settings.json.

**Not synced (machine-local):**

- `~/.pi/agent/auth.json` — credentials; re-authenticate with `/login` or API keys.
- `~/.pi/agent/sessions/` — session history.
- `~/.pi/agent/models-store.json` — regenerable model catalog.
- `~/.pi/agent/npm/`, `~/.pi/agent/git/` — installed packages, re-derived from `settings.json`.
- `~/.pi/learning/` — learning-layer state (optional; copy manually if you want continuity).

## Re-authenticating

`auth.json` is never synced. On a new machine, start pi and run `/login` (subscription providers) or set API keys via environment variables.
