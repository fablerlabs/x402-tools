#!/usr/bin/env bash
# build-mcpb.sh — bundle the MCP server and its optional x402 payment libraries
# into a .mcpb extension. Output: dist/fabler-x402-tools.mcpb
#
# Note: the official MCP registry entry (mcp/server.json) publishes the Worker's
# free remote catalog, not this .mcpb bundle. See README.md's "Publish" section
# for why both paths exist side by side.
#
# Usage: bash mcp/build-mcpb.sh   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/.."
bundle_dir="dist/mcpb"
rm -rf "$bundle_dir"
mkdir -p "$bundle_dir/mcp"
rm -f dist/fabler-x402-tools.mcpb

# Claude Desktop does not run npm install inside an .mcpb. Bundle the payment
# dependencies so setting X402_BUYER_PRIVATE_KEY actually enables signed retries.
./node_modules/.bin/esbuild mcp/server.js \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node18 \
  --outfile="$bundle_dir/mcp/server.js"

cp manifest.json LICENSE "$bundle_dir/"
python3 - <<'EOF'
from pathlib import Path
import zipfile

root = Path("dist/mcpb")
with zipfile.ZipFile("dist/fabler-x402-tools.mcpb", "w", zipfile.ZIP_DEFLATED) as z:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            info = zipfile.ZipInfo(str(path.relative_to(root)), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, path.read_bytes())
EOF
openssl dgst -sha256 dist/fabler-x402-tools.mcpb
