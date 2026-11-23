// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Aerial Screensaver - GNOME Shell Extension
 *
 * Plays a folder tree of aerial videos fullscreen after a period of
 * inactivity, with the clip's caption and a clock drawn over the video.
 *
 * Ported from Movie Screensaver by Gilson F.
 * (https://github.com/gilson-fonsaca/movie_screensaver, GPL-2.0). The idle
 * trigger, mpv process handling, dismissal, locking and top-bar menu follow
 * the original; the recursive folder playback, captions, clock and fill-screen
 * option are new.
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parseCaptionIndex, resolveCaption, textAt} from './captions.js';
import {INTERFACE_XML, OBJECT_PATH} from './control.js';

const LOGIN_DBUS_NAME = 'org.freedesktop.login1';
const LOGIN_DBUS_PATH = '/org/freedesktop/login1';
const LOGIN_DBUS_IFACE = 'org.freedesktop.login1.Manager';

const MAX_TIMEOUT_MINUTES = 60;
// The folder is usually a network mount. Never let a dead mount stall the Shell.
const FOLDER_TIMEOUT_MS = 4000;
// Ignore input for a moment after a manual start, so the click that started
// the screensaver (and the hand leaving the mouse) does not dismiss it.
const MANUAL_START_GRACE_MS = 1500;
const CAPTION_POLL_MS = 1000;
const CAPTION_FADE_MS = 600;

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

/** Run an async Gio call that is cancelled if it takes longer than timeoutMs. */
async function withTimeout(timeoutMs, call) {
    const cancellable = new Gio.Cancellable();
    const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        return await call(cancellable);
    } finally {
        if (!cancellable.is_cancelled())
            GLib.source_remove(timerId);
    }
}

/** A vertical St.BoxLayout on both older (vertical) and newer (orientation) Shells. */
function verticalBox(properties) {
    const box = new St.BoxLayout(properties);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// ─── Top-bar indicator ───────────────────────────────────────────────────────

const AerialScreensaverIndicator = GObject.registerClass(
class AerialScreensaverIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Aerial Screensaver'));
        this._ext = extension;
        this._settings = extension.settings;

        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._switches = new Map();
        this._addSwitch('enabled', _('Screensaver enabled'));
        this._addSwitch('shuffle-videos', _('Shuffle videos'));
        this._addSwitch('mute-video', _('Mute audio'));
        this._addSwitch('lock-screen-after', _('Lock screen after exit'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._timeoutLabel = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._timeoutLabel);
        const sliderItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', slider => {
            const minutes = Math.max(1, Math.round(slider.value * MAX_TIMEOUT_MINUTES));
            if (minutes !== this._settings.get_int('idle-timeout-minutes'))
                this._settings.set_int('idle-timeout-minutes', minutes);
        });
        sliderItem.add_child(this._slider);
        this.menu.addMenuItem(sliderItem);
        this._syncTimeout();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const startItem = new PopupMenu.PopupMenuItem(_('Start Screensaver Now'));
        startItem.connect('activate', () => {
            this.menu.close();
            this._ext.activateScreensaver(/* manual= */ true);
        });
        this.menu.addMenuItem(startItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Videos Folder and Settings…'));
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (this._switches.has(key))
                this._switches.get(key).setToggleState(this._settings.get_boolean(key));
            else if (key === 'idle-timeout-minutes')
                this._syncTimeout();
        });
    }

    _addSwitch(key, label) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, this._settings.get_boolean(key));
        item.connect('toggled', (_item, state) => this._settings.set_boolean(key, state));
        this.menu.addMenuItem(item);
        this._switches.set(key, item);
    }

    _syncTimeout() {
        const minutes = this._settings.get_int('idle-timeout-minutes');
        this._timeoutLabel.label.text = _('Start after %d min idle').format(minutes);
        this._slider.value = Math.min(1, minutes / MAX_TIMEOUT_MINUTES);
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

// ─── Overlays ────────────────────────────────────────────────────────────────

/** Fullscreen message shown only when playback cannot start. */
const ErrorActor = GObject.registerClass(
class ErrorActor extends St.Widget {
    _init(monitor, message, folderPath) {
        super._init({
            style_class: 'aerial-screensaver-error',
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            reactive: true,
        });
        const box = verticalBox({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Label({text: _('Aerial Screensaver'), style_class: 'aerial-screensaver-error-title'}));
        box.add_child(new St.Label({text: message, style_class: 'aerial-screensaver-error-message'}));
        box.add_child(new St.Label({text: folderPath, style_class: 'aerial-screensaver-error-path'}));
        this.add_child(box);
    }
});

/**
 * Transparent, non-reactive layer over one monitor: caption bottom-left,
 * date and time top-right. The mpv window shows through underneath.
 */
const OverlayActor = GObject.registerClass(
class OverlayActor extends St.Widget {
    _init(monitor, showCaptions, showClock) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            reactive: false,
        });

        this._captionBox = verticalBox({
            style_class: 'aerial-screensaver-caption-box',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.END,
            opacity: 0,
            visible: showCaptions,
        });
        this._title = new St.Label({
            style_class: 'aerial-screensaver-caption-title', x_align: Clutter.ActorAlign.START, visible: false,
        });
        this._text = new St.Label({style_class: 'aerial-screensaver-caption-text', x_align: Clutter.ActorAlign.START});
        this._captionBox.add_child(this._title);
        this._captionBox.add_child(this._text);
        this.add_child(this._captionBox);

        this._clockBox = verticalBox({
            style_class: 'aerial-screensaver-clock-box',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START,
            visible: showClock,
        });
        this._date = new St.Label({style_class: 'aerial-screensaver-clock-date', x_align: Clutter.ActorAlign.END});
        this._time = new St.Label({style_class: 'aerial-screensaver-clock-time', x_align: Clutter.ActorAlign.END});
        this._clockBox.add_child(this._date);
        this._clockBox.add_child(this._time);
        this.add_child(this._clockBox);
    }

    /** Show a caption, fading only when the text actually changes. */
    setCaption(title, text) {
        if (title === this._title.text && text === this._text.text)
            return;
        this._captionBox.remove_all_transitions();
        this._captionBox.ease({
            opacity: 0,
            duration: this._text.text ? CAPTION_FADE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._title.text = title;
                this._title.visible = title !== '';
                this._text.text = text;
                this._captionBox.ease({
                    opacity: 255,
                    duration: CAPTION_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    setClock(date, time) {
        this._date.text = date;
        this._time.text = time;
    }
});

// ─── mpv control socket ──────────────────────────────────────────────────────

/** Follows one mpv instance over its JSON IPC socket: current file and position. */
class MpvClient {
    constructor(socketPath, onPath) {
        this._socketPath = socketPath;
        this._onPath = onPath;
        this._cancellable = new Gio.Cancellable();
        this._connection = null;
        this._pending = new Map();
        this._nextId = 1;
        this._run().catch(e => {
            if (!this._cancellable.is_cancelled())
                console.warn('[AerialScreensaver] mpv control socket:', e.message);
        });
    }

    async _run() {
        // mpv creates the socket shortly after starting; retry until it exists.
        for (let attempt = 0; attempt < 40 && !this._connection; attempt++) {
            try {
                this._connection = await new Gio.SocketClient().connect_async(
                    Gio.UnixSocketAddress.new(this._socketPath), this._cancellable);
            } catch (e) {
                if (this._cancellable.is_cancelled())
                    return;
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
            }
        }
        if (!this._connection)
            throw new Error('could not connect');

        this._output = this._connection.get_output_stream();
        const input = new Gio.DataInputStream({base_stream: this._connection.get_input_stream()});
        const decoder = new TextDecoder();
        this._send({command: ['observe_property', 1, 'path']});

        while (!this._cancellable.is_cancelled()) {
            const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            if (line === null)
                break;  // mpv closed the socket
            let message;
            try {
                message = JSON.parse(decoder.decode(line));
            } catch (_e) {
                continue;
            }
            if (message.event === 'property-change' && message.name === 'path' && message.data)
                this._onPath(message.data);
            else if (message.request_id !== undefined && this._pending.has(message.request_id)) {
                this._pending.get(message.request_id)(message.error === 'success' ? message.data : null);
                this._pending.delete(message.request_id);
            }
        }
    }

    _send(message) {
        if (!this._output)
            return;
        try {
            this._output.write_all(new TextEncoder().encode(`${JSON.stringify(message)}\n`), null);
        } catch (_e) {
            // mpv has gone away; the reader loop ends on its own
        }
    }

    /** Current playback position in seconds, or null if unknown. */
    position() {
        return new Promise(resolve => {
            if (!this._output) {
                resolve(null);
                return;
            }
            const id = this._nextId++;
            this._pending.set(id, resolve);
            this._send({command: ['get_property', 'time-pos'], request_id: id});
        });
    }

    destroy() {
        this._cancellable.cancel();
        for (const resolve of this._pending.values())
            resolve(null);
        this._pending.clear();
        try {
            this._connection?.close(null);
        } catch (_e) {
            // already closed
        }
        this._connection = null;
        this._output = null;
    }
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default class AerialScreensaverExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._active = false;
        this._generation = 0;       // bumped on every start/stop to drop stale async work
        this._players = [];         // [{proc, pid, monitorIndex, socketPath, client, overlay, caption}]
        this._errorActors = [];
        this._idleWatchId = null;
        this._userActiveWatchId = null;
        this._graceTimeoutId = null;
        this._pollId = null;
        this._clockId = null;
        this._windowCreatedId = null;
        this._loginProxy = null;
        this._suspendSignalId = null;

        this._runtimeDir = GLib.get_user_runtime_dir();
        this._markerFile = GLib.build_filenamev([this._runtimeDir, 'aerial-screensaver.pids']);

        this._indicator = new AerialScreensaverIndicator(this);
        Main.panel.addToStatusArea('aerial-screensaver', this._indicator);

        // Lets the preferences window (a separate process) start the screensaver.
        this._control = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, {
            Start: () => this.activateScreensaver(/* manual= */ true),
        });
        this._control.export(Gio.DBus.session, OBJECT_PATH);

        this._connectLogind();
        this._applyIdleMonitor();
        this._settingsChangedId = this.settings.connect('changed', (_s, key) => {
            if (key === 'idle-timeout-minutes' || key === 'enabled')
                this._applyIdleMonitor();
        });

        this._killOrphanedPlayers();

        // Prompt for the folder the first time, instead of failing at idle time.
        if (this.settings.get_string('videos-folder').trim() === '')
            this.openPreferences();
    }

    disable() {
        // This extension does not run on the lock screen (no unlock-dialog
        // session mode), so the screensaver stops when the screen locks.
        this._indicator?.destroy();
        this._indicator = null;
        this._control?.unexport();
        this._control = null;

        if (this._settingsChangedId) {
            this.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._removeIdleWatch();
        this._disconnectLogind();
        this._stopScreensaver(false);
        this.settings = null;
    }

    // ── Idle trigger ─────────────────────────────────────────────────────────

    _applyIdleMonitor() {
        this._removeIdleWatch();
        if (!this.settings.get_boolean('enabled'))
            return;
        const minutes = this.settings.get_int('idle-timeout-minutes');
        if (minutes <= 0)
            return;
        this._idleWatchId = global.backend.get_core_idle_monitor().add_idle_watch(
            minutes * 60 * 1000, () => this.activateScreensaver(false));
    }

    _removeIdleWatch() {
        if (this._idleWatchId !== null) {
            global.backend.get_core_idle_monitor().remove_watch(this._idleWatchId);
            this._idleWatchId = null;
        }
    }

    // ── Suspend: stop playing before the machine sleeps ──────────────────────

    _connectLogind() {
        try {
            this._loginProxy = Gio.DBusProxy.new_sync(
                Gio.DBus.system,
                Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null, LOGIN_DBUS_NAME, LOGIN_DBUS_PATH, LOGIN_DBUS_IFACE, null);
            this._suspendSignalId = this._loginProxy.connectSignal(
                'PrepareForSleep', (_proxy, _sender, [sleeping]) => {
                    if (sleeping)
                        this._stopScreensaver(false);
                });
        } catch (e) {
            console.warn('[AerialScreensaver] Could not connect to logind:', e.message);
            this._loginProxy = null;
        }
    }

    _disconnectLogind() {
        if (this._loginProxy && this._suspendSignalId)
            this._loginProxy.disconnectSignal(this._suspendSignalId);
        this._suspendSignalId = null;
        this._loginProxy = null;
    }

    // ── Screensaver lifecycle ────────────────────────────────────────────────

    activateScreensaver(manual = false) {
        if (this._active)
            return;
        this._active = true;
        const generation = ++this._generation;
        this._start(generation, manual).catch(e => {
            console.error('[AerialScreensaver] start failed:', e.message);
            if (generation === this._generation)
                this._showError(_('Could not start playback: %s').format(e.message), '');
        });
    }

    async _start(generation, manual) {
        const folder = this.settings.get_string('videos-folder').trim();

        // Watch for input first, so even an error screen can be dismissed.
        if (manual) {
            this._graceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MANUAL_START_GRACE_MS, () => {
                this._graceTimeoutId = null;
                this._watchForInput();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._watchForInput();
        }

        if (folder === '') {
            this._showError(_('No videos folder is set. Choose one in the extension settings.'), '');
            return;
        }
        if (GLib.find_program_in_path('mpv') === null) {
            this._showError(_('mpv is not installed.'), '');
            return;
        }

        const isFolder = await this._isFolder(folder);
        if (generation !== this._generation)
            return;
        if (!isFolder) {
            this._showError(_('Videos folder not found or not reachable.'), folder);
            return;
        }

        const captions = this.settings.get_boolean('show-captions')
            ? await this._loadCaptions(folder) : new Map();
        if (generation !== this._generation)
            return;

        this._captionIndex = captions;
        // In the overview the video would only be a window thumbnail.
        if (Main.overview.visible)
            Main.overview.hide();
        this._launchPlayers(folder);
        this._startClock();
    }

    async _isFolder(path) {
        try {
            const info = await withTimeout(FOLDER_TIMEOUT_MS, cancellable =>
                Gio.File.new_for_path(path).query_info_async(
                    'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable));
            return info.get_file_type() === Gio.FileType.DIRECTORY;
        } catch (_e) {
            return false;
        }
    }

    /** captions.json is optional: without it every clip is captioned by its file name. */
    async _loadCaptions(folder) {
        try {
            const [contents] = await withTimeout(FOLDER_TIMEOUT_MS, cancellable =>
                Gio.File.new_for_path(GLib.build_filenamev([folder, 'captions.json']))
                    .load_contents_async(cancellable));
            return parseCaptionIndex(new TextDecoder().decode(contents));
        } catch (_e) {
            return new Map();
        }
    }

    _stopScreensaver(lockScreen) {
        if (!this._active)
            return;
        this._active = false;
        this._generation++;

        this._unwatchInput();
        this._stopClock();
        this._stopCaptionPoll();
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }

        for (const player of this._players) {
            player.client?.destroy();
            try {
                player.proc.force_exit();
            } catch (_e) {
                // already gone
            }
            if (player.overlay) {
                Main.uiGroup.remove_child(player.overlay);
                player.overlay.destroy();
            }
            this._deleteFile(player.socketPath);
        }
        this._players = [];
        this._deleteFile(this._markerFile);

        for (const actor of this._errorActors) {
            Main.uiGroup.remove_child(actor);
            actor.destroy();
        }
        this._errorActors = [];

        if (lockScreen && this.settings?.get_boolean('lock-screen-after'))
            Main.screenShield?.lock(false);
    }

    // ── Players ──────────────────────────────────────────────────────────────

    /**
     * One mpv per monitor. mpv expands the folder tree itself and shuffles it,
     * so the Shell never walks the (network) folder.
     */
    _launchPlayers(folder) {
        const mute = this.settings.get_boolean('mute-video');
        const shuffle = this.settings.get_boolean('shuffle-videos');
        const fill = this.settings.get_boolean('fill-screen');
        const showCaptions = this.settings.get_boolean('show-captions');
        const showClock = this.settings.get_boolean('show-clock');
        const monitors = Main.layoutManager.monitors;

        // mpv cannot choose its monitor or stay on top under Wayland, so place
        // each window from here as it appears.
        this._windowCreatedId = global.display.connect('window-created', (_display, window) => {
            const player = this._players.find(p => p.pid === window.get_pid());
            if (!player)
                return;
            if (window.get_monitor() !== player.monitorIndex)
                window.move_to_monitor(player.monitorIndex);
            if (!window.is_fullscreen())
                window.make_fullscreen();
            window.make_above();
            // Focus it ourselves, or the Shell announces "window is ready" instead.
            window.activate(global.get_current_time());
        });

        for (let index = 0; index < monitors.length; index++) {
            const socketPath = GLib.build_filenamev([this._runtimeDir, `aerial-screensaver-${index}.sock`]);
            this._deleteFile(socketPath);
            const argv = [
                'mpv',
                '--fs', `--screen=${index}`, `--fs-screen=${index}`,
                '--no-border', '--ontop', '--force-window=yes',
                '--wayland-app-id=aerial-screensaver', '--title=Aerial Screensaver',
                '--loop-playlist=inf', '--directory-mode=recursive', '--directory-filter-types=video',
                ...shuffle ? ['--shuffle'] : [],
                '--hwdec=auto', '--no-terminal', '--really-quiet',
                '--osc=no', '--osd-level=0', '--cursor-autohide=always',
                // Keys such as Esc or q must not act on mpv itself; any input
                // dismisses the screensaver through the Shell instead.
                '--no-input-default-bindings', '--input-conf=/dev/null',
                '--stop-screensaver=no',
                `--panscan=${fill ? '1.0' : '0.0'}`,
                // Only the first monitor may play sound.
                `--mute=${mute || index > 0 ? 'yes' : 'no'}`,
                `--input-ipc-server=${socketPath}`,
                '--', folder,
            ];

            let proc;
            try {
                proc = new Gio.Subprocess({argv, flags: Gio.SubprocessFlags.NONE});
                proc.init(null);
            } catch (e) {
                this._showError(_('Failed to launch mpv: %s').format(e.message), folder);
                return;
            }

            const player = {
                proc, monitorIndex: index, socketPath,
                pid: parseInt(proc.get_identifier(), 10),
                overlay: null, client: null, caption: null,
            };
            if (showCaptions || showClock) {
                player.overlay = new OverlayActor(monitors[index], showCaptions, showClock);
                Main.uiGroup.add_child(player.overlay);
            }
            if (showCaptions)
                player.client = new MpvClient(socketPath, path => this._onClipChanged(player, path));
            this._players.push(player);

            const generation = this._generation;
            proc.wait_async(null, (_proc, result) => {
                try {
                    _proc.wait_finish(result);
                } catch (_e) {
                    // nothing to report
                }
                if (generation !== this._generation)
                    return;  // we stopped it ourselves
                this._showError(_('The video player exited unexpectedly.'), folder);
            });
        }

        // Remember the players so a Shell restart can clean them up.
        const pids = this._players.map(p => p.pid).join('\n');
        Gio.File.new_for_path(this._markerFile).replace_contents_async(
            new TextEncoder().encode(pids), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (_e) {
                    // not fatal
                }
            });
    }

    /** Stop players left behind by a previous instance of the extension. */
    _killOrphanedPlayers() {
        const file = Gio.File.new_for_path(this._markerFile);
        file.load_contents_async(null, (_file, result) => {
            let pids = [];
            try {
                const [, contents] = file.load_contents_finish(result);
                pids = new TextDecoder().decode(contents).split('\n')
                    .map(line => parseInt(line, 10)).filter(pid => pid > 0);
            } catch (_e) {
                return;  // no marker file: nothing was left running
            }
            for (const pid of pids) {
                // Only signal the pid if it is still one of our players.
                try {
                    const [, cmdline] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
                    if (new TextDecoder().decode(cmdline).includes('aerial-screensaver'))
                        GLib.spawn_command_line_async(`kill ${pid}`);
                } catch (_e) {
                    // process already gone
                }
            }
            if (!this._active)
                this._deleteFile(this._markerFile);
        });
    }

    _deleteFile(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {
            // did not exist
        }
    }

    // ── Captions and clock ───────────────────────────────────────────────────

    _onClipChanged(player, path) {
        if (!this._active || !player.overlay)
            return;
        player.caption = resolveCaption(path, this._captionIndex);
        player.overlay.setCaption(player.caption.title, player.caption.points[0].text);

        // Only clips with captions that change over time need the position.
        if (this._players.some(p => p.caption && p.caption.points.length > 1))
            this._startCaptionPoll();
        else
            this._stopCaptionPoll();
    }

    _startCaptionPoll() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAPTION_POLL_MS, () => {
            for (const player of this._players) {
                const caption = player.caption;
                if (!caption || caption.points.length < 2 || !player.client)
                    continue;
                player.client.position().then(seconds => {
                    // Ignore the answer if the clip changed while we were asking.
                    if (seconds !== null && player.caption === caption && player.overlay && this._active)
                        player.overlay.setCaption(caption.title, textAt(caption, seconds));
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCaptionPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
    }

    _startClock() {
        if (!this.settings.get_boolean('show-clock'))
            return;
        const use24h = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('clock-format') === '24h';
        const update = () => {
            const now = GLib.DateTime.new_now_local();
            const date = now.format('%A, %B %-d, %Y');
            const time = now.format(use24h ? '%H:%M' : '%-l:%M %p');
            for (const player of this._players)
                player.overlay?.setClock(date, time);
            return GLib.SOURCE_CONTINUE;
        };
        update();
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, update);
    }

    _stopClock() {
        if (this._clockId) {
            GLib.source_remove(this._clockId);
            this._clockId = null;
        }
    }

    // ── Errors ───────────────────────────────────────────────────────────────

    _showError(message, folderPath) {
        console.error('[AerialScreensaver]', message, folderPath);
        if (!this._active || this._errorActors.length > 0)
            return;
        for (const monitor of Main.layoutManager.monitors) {
            const actor = new ErrorActor(monitor, message, folderPath);
            Main.uiGroup.add_child(actor);
            this._errorActors.push(actor);
        }
    }

    // ── Dismissal ────────────────────────────────────────────────────────────

    /** The next key press, click or pointer movement ends the screensaver. */
    _watchForInput() {
        if (!this._active || this._userActiveWatchId !== null)
            return;
        this._userActiveWatchId = global.backend.get_core_idle_monitor().add_user_active_watch(() => {
            this._userActiveWatchId = null;  // one-shot: already removed
            this._stopScreensaver(true);
        });
    }

    _unwatchInput() {
        if (this._graceTimeoutId) {
            GLib.source_remove(this._graceTimeoutId);
            this._graceTimeoutId = null;
        }
        if (this._userActiveWatchId !== null) {
            global.backend.get_core_idle_monitor().remove_watch(this._userActiveWatchId);
            this._userActiveWatchId = null;
        }
    }
}
