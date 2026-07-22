#!/bin/bash
# Run this locally after exporting cookies.txt from your logged-in threejsassets.com session.
# Do not commit or share cookies.txt.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COOKIE_FILE="$SCRIPT_DIR/cookies.txt"
OUT_DIR="$SCRIPT_DIR/../public/assets/models"

if [ ! -f "$COOKIE_FILE" ]; then
  echo "Missing $COOKIE_FILE. Export cookies.txt from your browser session first."
  exit 1
fi

mkdir -p "$OUT_DIR"

ASSETS=(
  plaza-paving-01 grass-verge-01 road-straight-01 road-corner-01
  road-intersection-01 road-t-01 sidewalk-01 street-tree-01
  flower-planter-01 shop-awning-01 corner-store-01 apartment-block-01
  glass-skyscraper-01 convenience-store-01 traffic-light-01 street-lamp-01
  bus-shelter-01 bench-01 trash-bin-01 street-sign-01 car-sedan-01
  taxi-01 sky-day-dome-01
)

for slug in "${ASSETS[@]}"; do
  echo "Downloading $slug..."
  curl -sL -b "$COOKIE_FILE" \
    -o "$OUT_DIR/${slug}.glb" \
    "https://threejsassets.com/api/download/free/${slug}"
done

echo ""
echo "Done. Checking file types (should be 'glTF binary', not HTML):"
file "$OUT_DIR"/*.glb
