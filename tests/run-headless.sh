#!/usr/bin/env bash
# Run the extension in a throwaway, headless GNOME Shell and screenshot it.
# Nothing here touches the real session: config, data, cache and runtime dirs
# are all temporary, and the Shell runs on its own D-Bus session bus.
#
# Usage: tests/run-headless.sh VIDEOS_FOLDER OUTPUT_DIR [SECONDS_TO_PLAY]
#
# Optional environment:
#   AERIAL_TEST_IDLE_MINUTES=1    wait for the idle timer instead of starting directly
#   AERIAL_TEST_CLICK="X Y"       open the preferences window (saved as prefs.png), start
#                                 by clicking there ("Start Now"), and stop by moving the pointer
#   AERIAL_TEST_FILE=/path/clip   after starting, jump to this clip ...
#   AERIAL_TEST_SEEKS="2 30 60"   ... and report the caption at these positions
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VIDEOS="${1:?videos folder}"; OUT="${2:?output dir}"; PLAY="${3:-20}"
UUID="aerial-screensaver@wallacebw.github.io"
T="$(mktemp -d /tmp/aerial-headless.XXXXXX)"
mkdir -p "$T"/{config,data,cache,run} "$OUT"; chmod 700 "$T/run"
export XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/run"
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS

EXT="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$EXT/$UUID/schemas" "$EXT/unsafe@test"
cp "$HERE"/{extension.js,prefs.js,captions.js,control.js,metadata.json,stylesheet.css} "$EXT/$UUID/"
cp "$HERE"/schemas/*.gschema.xml "$EXT/$UUID/schemas/"
glib-compile-schemas "$EXT/$UUID/schemas"
# Test-only helper: lets this script evaluate JS in the Shell and take screenshots.
cat > "$EXT/unsafe@test/metadata.json" <<'J'
{"name": "unsafe test helper", "description": "test only", "uuid": "unsafe@test", "shell-version": ["47", "48", "49", "50", "51"]}
J
cat > "$EXT/unsafe@test/extension.js" <<'J'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Unsafe extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
J

cat > "$T/inner.sh" <<INNER
gsettings set org.gnome.shell enabled-extensions "['$UUID', 'unsafe@test']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface enable-animations true
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999.0'
# The test pointer starts in the top-left corner; the hot corner there would trap it.
gsettings set org.gnome.desktop.interface enable-hot-corners false
S="gsettings --schemadir $EXT/$UUID/schemas set org.gnome.shell.extensions.aerial-screensaver"
\$S videos-folder "$VIDEOS"
\$S idle-timeout-minutes \${AERIAL_TEST_IDLE_MINUTES:-60}
# The preferences window is started by D-Bus activation and must find the test compositor.
dbus-update-activation-environment WAYLAND_DISPLAY=wayland-aerialtest GDK_BACKEND=wayland
gnome-shell --headless --virtual-monitor 3440x1440 --wayland-display wayland-aerialtest > "$OUT/shell.log" 2>&1 &
SHELL_PID=\$!
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "\$1" 2>&1; }
for i in \$(seq 1 40); do sleep 0.5; ev "1+1" 2>/dev/null | grep -q "true" && break; done
echo "eval ready: \$(ev '1+1')"
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "\$1" 2>&1 | tail -1; }
active() { ev "Main.extensionManager.lookup('$UUID').stateObj._active"; }
# Real pointer input through a virtual device: pointer move X Y, or pointer click X Y.
pointer() { ev "(() => { const C = imports.gi.Clutter; const d = globalThis._aerialTestPointer ??= global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const t = () => GLib.get_monotonic_time(); d.notify_absolute_motion(t(), \$2, \$3); if ('\$1' === 'click') { d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED); } return '\$1 ' + \$2 + ',' + \$3; })()"; }
echo "extension state: \$(ev "Main.extensionManager.lookup('$UUID')?.state")  error: \$(ev "Main.extensionManager.lookup('$UUID')?.error")"
if [ -n "\${AERIAL_TEST_IDLE_MINUTES:-}" ]; then
  # Let the idle timer start it (a headless Shell has no input, so it is idle from the start).
  echo "waiting for the idle timer..."; sleep \$((AERIAL_TEST_IDLE_MINUTES * 60 + 5))
  echo "active after idle: \$(ev "Main.extensionManager.lookup('$UUID').stateObj._active")"
elif [ -n "\${AERIAL_TEST_CLICK:-}" ]; then
  # Start it the way a user does: the "Start Now" button in the preferences window.
  # A fresh session starts in the overview, where a click would only pick the window.
  ev "Main.overview.hide(); 'hidden'" >/dev/null
  gnome-extensions prefs $UUID; sleep 5
  echo "prefs shot: \$(shot "$OUT/prefs.png")"
  # Move first and let the Shell find what is under the pointer, then click.
  pointer move \$AERIAL_TEST_CLICK >/dev/null; sleep 0.5
  echo "\$(pointer click \$AERIAL_TEST_CLICK)  overview: \$(ev "Main.overview.visible")"
  sleep 1; echo "active after click: \$(active)"
  # Past the grace period the click's own input must not have dismissed it.
  sleep 3; echo "active after grace period: \$(active)"
else
  # Start through the control interface the preferences button uses.
  echo "start: \$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/AerialScreensaver --method org.gnome.Shell.Extensions.AerialScreensaver.Start 2>&1)  active: \$(active)"
fi
sleep 8; echo "shot1: \$(shot "$OUT/shot1.png")"
echo "players: \$(pgrep -f '^mpv .*wayland-app-id=aerial-screensaver' | wc -l)  overview: \$(ev "Main.overview.visible")  windows: \$(ev "global.get_window_actors().map(a => a.meta_window.get_wm_class() + ':' + a.meta_window.is_fullscreen() + ':' + a.meta_window.is_above()).join(',')")"
echo "caption: \$(ev "(() => { const e = Main.extensionManager.lookup('$UUID').stateObj; const p = e._players[0]; return JSON.stringify({title: p.overlay._title.text, text: p.overlay._text.text, date: p.overlay._date.text, time: p.overlay._time.text, points: p.caption?.points.length}); })()")"
if [ -n "\${AERIAL_TEST_FILE:-}" ]; then
  echo "load: \$(ev "Main.extensionManager.lookup('$UUID').stateObj._players[0].client._send({command: ['loadfile', '\$AERIAL_TEST_FILE']}); 'sent'")"
  sleep 4
  for at in \${AERIAL_TEST_SEEKS:-}; do
    ev "Main.extensionManager.lookup('$UUID').stateObj._players[0].client._send({command: ['seek', \$at, 'absolute']}); 'seek'" >/dev/null
    sleep 3
    echo "caption at \${at}s: \$(ev "(() => { const p = Main.extensionManager.lookup('$UUID').stateObj._players[0]; return p.overlay._title.text + ' | ' + p.overlay._text.text; })()")"
  done
fi
sleep $PLAY; echo "shot2: \$(shot "$OUT/shot2.png")"
echo "caption later: \$(ev "(() => { const p = Main.extensionManager.lookup('$UUID').stateObj._players[0]; return JSON.stringify({title: p.overlay._title.text, text: p.overlay._text.text}); })()")"
if [ -n "\${AERIAL_TEST_CLICK:-}" ]; then
  echo "\$(pointer move 200 200)"; sleep 1; echo "active after pointer movement: \$(active)"
else
  echo "stop: \$(ev "Main.extensionManager.lookup('$UUID').stateObj._stopScreensaver(false); 'stopped'")"
fi
sleep 1; echo "players after stop: \$(pgrep -f '^mpv .*wayland-app-id=aerial-screensaver' | wc -l)  leftover sockets: \$(ls "$XDG_RUNTIME_DIR" | grep -c aerial-screensaver)"
kill \$SHELL_PID; wait \$SHELL_PID 2>/dev/null
INNER
dbus-run-session -- bash "$T/inner.sh"
echo "--- shell log: errors mentioning the extension ---"
grep -iE "aerial|JS ERROR|SyntaxError|TypeError|ReferenceError" "$OUT/shell.log" | grep -viE "unsafe@test" | head -20
echo "temp profile left at $T"
