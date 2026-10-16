#!/usr/bin/env bash
# Build the Claude Code plugin release zip from an already-built dist/.
#
#   scripts/package-plugin.sh <out-dir>    # writes <out-dir>/wcl-mcp-<version>.zip
#
# The zip's top level is the plugin root: Claude Code installs it from the marketplace's
# `archive` source and runs the lockfile npm install itself, so node_modules isn't included.
set -euo pipefail

out_dir="$(mkdir -p "${1:?usage: package-plugin.sh <out-dir>}" && cd "$1" && pwd)"
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$repo/package.json').version")"
plugin_version="$(node -p "require('$repo/.claude-plugin/plugin.json').version")"
if [[ "$version" != "$plugin_version" ]]; then
  echo "package.json ($version) and .claude-plugin/plugin.json ($plugin_version) versions differ" >&2
  exit 1
fi
if [[ ! -f "$repo/dist/index.js" ]]; then
  echo "dist/ is missing; run npm run build first" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/.claude-plugin"
cp "$repo/.claude-plugin/plugin.json" "$stage/.claude-plugin/"
cp "$repo/package.json" "$repo/package-lock.json" "$repo/README.md" "$stage/"
# Runtime JS (and source maps for stack traces); type declarations aren't needed.
rsync -a --exclude '*.d.ts' --exclude '*.d.ts.map' "$repo/dist/" "$stage/dist/"

zip_path="$out_dir/wcl-mcp-$version.zip"
rm -f "$zip_path"
(cd "$stage" && zip -qr -X "$zip_path" .)
echo "$zip_path"
