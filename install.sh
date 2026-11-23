#!/usr/bin/env bash
# Install Aerial Screensaver for the current user.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="aerial-screensaver@wallacebw.github.io"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

command -v mpv >/dev/null || echo "warning: mpv is not installed; the screensaver needs it to play videos" >&2

mkdir -p "$DEST/schemas"
cp "$HERE"/{extension.js,prefs.js,captions.js,control.js,metadata.json,stylesheet.css,LICENSE} "$DEST/"
cp "$HERE"/schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled."
else
    echo "Log out and back in (Wayland cannot load a new extension into a running session), then run:"
    echo "    gnome-extensions enable $UUID"
fi
