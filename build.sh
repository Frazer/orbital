#!/bin/sh
# Builds the two uploads: dist/orbital-itch.zip (the plain game) and dist/orbital-crazygames.zip (with the CrazyGames SDK).
# The game is index.html plus audio.js, the Quantico font and the PeerJS library, all at the zip root.
set -e
cd "$(dirname "$0")"
mkdir -p dist/cg
rm -f dist/orbital-itch.zip dist/orbital-crazygames.zip
FILES="audio.js peerjs.min.js quantico.woff2"
zip -j -q dist/orbital-itch.zip index.html $FILES
sed 's|<!-- platform -->|<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>\
    <meta name="orbital-platform" content="crazygames">|' index.html > dist/cg/index.html
cp $FILES dist/cg/
zip -j -q dist/orbital-crazygames.zip dist/cg/index.html dist/cg/audio.js dist/cg/peerjs.min.js dist/cg/quantico.woff2
ls -la dist/orbital-itch.zip dist/orbital-crazygames.zip
