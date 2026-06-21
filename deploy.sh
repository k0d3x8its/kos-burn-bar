#!/usr/bin/env bash
# Deploy plugin files to all Obsidian vaults.
# Usage: ./deploy.sh [--vaults "path1 path2"]

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES=(main.js styles.css manifest.json kos-burn-tap.sh)

VAULTS=(
  "$HOME/Documents/ace-vault/.obsidian/plugins/kos-burn-bar"
  "$HOME/Documents/kodex-vault/.obsidian/plugins/kos-burn-bar"
)

ok=0
fail=0

for vault in "${VAULTS[@]}"; do
  if [[ ! -d "$vault" ]]; then
    echo "  SKIP  $vault (directory not found)"
    continue
  fi
  for f in "${FILES[@]}"; do
    src="$PLUGIN_DIR/$f"
    if [[ ! -f "$src" ]]; then
      echo "  MISS  $f (not in plugin dir — skipped)"
      continue
    fi
    cp "$src" "$vault/$f"
    echo "  OK    $vault/$f"
    (( ok++ )) || true
  done
done

echo ""
echo "Deployed $ok file(s). Reload the plugin in Obsidian to pick up changes."
