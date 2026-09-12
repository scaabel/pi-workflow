#!/usr/bin/env bash
#
# pi-workflow bootstrap — links this repo into ~/.pi/agent/ on a fresh machine.
# Idempotent: safe to re-run any time.
#
# Usage:
#   git clone git@github.com:scaabel/pi-workflow.git ~/Projects/pi-workflow
#   cd ~/Projects/pi-workflow
#   ./install.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${HOME}/.pi/agent"

c_reset=$'\033[0m'; c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'
c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'
info(){ printf '%s==>%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok(){   printf '%s  ok%s %s\n' "$c_green" "$c_reset" "$*"; }
warn(){ printf '%s warn%s %s\n' "$c_yellow" "$c_reset" "$*"; }
err(){  printf '%s fail%s %s\n' "$c_red" "$c_reset" "$*" >&2; }
have(){ command -v "$1" >/dev/null 2>&1; }

# link <name> <repo-relative-path>
# Symlinks $CONFIG_DIR/<name> -> $REPO_DIR/<path>, backing up any existing real
# file/dir first so nothing is lost.
link(){
  local name="$1" src="$2"
  local target="${CONFIG_DIR}/${name}"
  mkdir -p "$CONFIG_DIR"
  if [[ -L "$target" ]]; then
    if [[ "$(readlink "$target")" == "$REPO_DIR/$src" ]]; then
      ok "already linked: $name"
      return
    fi
    warn "replacing existing symlink: $name"
    rm -f "$target"
  elif [[ -e "$target" ]]; then
    local bak="${target}.backup-$(date +%Y%m%d-%H%M%S)"
    warn "backing up existing $target -> $bak"
    mv "$target" "$bak"
  fi
  ln -sfn "$REPO_DIR/$src" "$target"
  ok "linked $name -> $REPO_DIR/$src"
}

main(){
  info "pi-workflow bootstrap from $REPO_DIR"

  have git || { err "git is required to clone this repo"; exit 1; }
  have pi  || {
    err "pi is not installed."
    err "Install it with:  npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
    exit 1
  }

  link extensions   extensions
  link agents       agents
  link prompts      prompts
  link themes       themes
  link settings.json settings.json

  info "Installing pi packages (from settings.json)"
  # Add a line here whenever settings.json "packages" grows.
  pi install npm:pi-opencode-bridge
  pi install git:github.com/DietrichGebert/ponytail
  pi install npm:pi-ast-grep
  ok "packages installed"

  cat <<'NEXT'

Next steps:
  * Authenticate: run `pi` and use /login (or set API keys) — auth.json is
    machine-local and intentionally not synced.
  * Verify: run `pi` in a project and confirm your extensions and subagents
    load (use /reload if it was already running).
NEXT
}

main "$@"
