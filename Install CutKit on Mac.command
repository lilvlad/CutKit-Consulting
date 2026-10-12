#!/bin/bash
# CutKit installer for Premiere Pro (macOS).
# Links the panel into Adobe's extensions folder (edits here show up after reopening the panel),
# then makes sure ffmpeg, Whisper and the Whisper model are there.
cd "$(dirname "$0")"
SRC="$(pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/CutKit"
MODELS="$HOME/Library/Application Support/CutKit/models"

for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$SRC" 2>/dev/null

if ! command -v brew >/dev/null; then
  echo "  Homebrew is needed for ffmpeg and Whisper: https://brew.sh"
else
  command -v ffmpeg >/dev/null || brew install ffmpeg
  command -v whisper-cli >/dev/null || brew install whisper-cpp
fi
mkdir -p "$MODELS"
if [ ! -f "$MODELS/ggml-large-v3-turbo.bin" ]; then
  echo "  Downloading the Whisper model (1.6 GB, once)…"
  curl -L --fail -o "$MODELS/ggml-large-v3-turbo.bin.part" \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin \
    && mv "$MODELS/ggml-large-v3-turbo.bin.part" "$MODELS/ggml-large-v3-turbo.bin"
fi

echo ""
if [ -f "$DEST/CSXS/manifest.xml" ]; then
  echo "  CutKit installed (linked to $SRC)."
  echo "  Restart Premiere Pro, then open: Window > Extensions > CutKit by Vlad"
else
  echo "  Install failed: could not link $DEST"
fi
echo ""
read -n 1 -s -r -p "Press any key to close"
