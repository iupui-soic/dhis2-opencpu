#!/usr/bin/env bash
# Bundle the app into an installable DHIS2 custom-app zip.
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="dist"
ZIP="OpenCPU-Statistical-Analysis.zip"

FILES=(index.html app.js dhis2.js opencpu.js style.css manifest.webapp icon.png)

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ZIP"
zip -j "$OUT_DIR/$ZIP" "${FILES[@]}"

echo "Created $OUT_DIR/$ZIP"
echo "Upload it via DHIS2 → App Management → Upload app."