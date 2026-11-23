#!/bin/sh
# Builds the uploads: dist/orbital-itch.zip (the plain game) and dist/orbital-crazygames.zip (with the CrazyGames SDK in the head).
set -e
cd "$(dirname "$0")"
mkdir -p dist/cg
rm -f dist/orbital-itch.zip dist/orbital-crazygames.zip
zip -j -q dist/orbital-itch.zip index.html audio.js
sed 's|<!-- platform -->|<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>\
  <meta name="orbital-platform" content="crazygames">|' index.html > dist/cg/index.html
cp audio.js dist/cg/audio.js
zip -j -q dist/orbital-crazygames.zip dist/cg/index.html dist/cg/audio.js
ls -la dist/orbital-itch.zip dist/orbital-crazygames.zip
