#!/usr/bin/env bash
# build-mcpb.sh — pack the MCP server into a .mcpb bundle (manifest.json at
# zip root + mcp/server.js + mcp/tools.js + LICENSE) for one-click install as
# a Claude Desktop extension. Output: dist/fabler-x402-tools.mcpb
#
# Note: the official MCP registry entry (mcp/server.json) publishes the Worker's
# free remote catalog, not this .mcpb bundle. See README.md's "Publish" section
# for why both paths exist side by side.
#
# Usage: bash mcp/build-mcpb.sh   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/fabler-x402-tools.mcpb
python3 - <<'EOF'
import zipfile
with zipfile.ZipFile("dist/fabler-x402-tools.mcpb", "w", zipfile.ZIP_DEFLATED) as z:
    for f in ["manifest.json", "mcp/server.js", "mcp/tools.js", "LICENSE"]:
        z.write(f)
EOF
openssl dgst -sha256 dist/fabler-x402-tools.mcpb
