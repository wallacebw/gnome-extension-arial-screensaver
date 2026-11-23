// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences window for Aerial Screensaver.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BUS_NAME, INTERFACE, OBJECT_PATH} from './control.js';

export default class AerialScreensaverPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);
        // Tall enough to show every row, down to the test button, without scrolling.
        window.set_default_size(640, 900);

        // ── Videos ──
        const videos = new Adw.PreferencesGroup({
            title: _('Videos'),
            description: GLib.find_program_in_path('mpv') === null
                ? _('mpv is not installed. Install it, or the screensaver cannot play anything.')
                : _('Every video in the folder and its subfolders is played.'),
        });
        page.add(videos);

        const folderRow = new Adw.ActionRow({title: _('Videos folder')});
        const syncFolder = () => {
            const folder = settings.get_string('videos-folder');
            folderRow.subtitle = folder === '' ? _('Not set') : folder;
        };
        syncFolder();
        settings.connect('changed::videos-folder', syncFolder);

        const chooseButton = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Choose the videos folder'), modal: true});
            const current = settings.get_string('videos-folder');
            if (current !== '')
                dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (_dialog, result) => {
                try {
                    const folder = dialog.select_folder_finish(result);
                    settings.set_string('videos-folder', folder.get_path());
                } catch (_e) {
                    // dialog dismissed
                }
            });
        });
        folderRow.add_suffix(chooseButton);
        folderRow.activatable_widget = chooseButton;
        videos.add(folderRow);

        const addSwitch = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };
        addSwitch(videos, 'shuffle-videos', _('Shuffle'), _('Play the clips in random order'));
        addSwitch(videos, 'mute-video', _('Mute'), _('Play without sound'));

        // ── Behaviour ──
        const behaviour = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviour);
        addSwitch(behaviour, 'enabled', _('Start when idle'));
        const timeoutRow = Adw.SpinRow.new_with_range(1, 120, 1);
        timeoutRow.title = _('Minutes of inactivity');
        settings.bind('idle-timeout-minutes', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(timeoutRow);
        addSwitch(behaviour, 'lock-screen-after', _('Lock the screen afterwards'),
            _('Lock when the screensaver is dismissed'));

        // ── Appearance ──
        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(appearance);
        addSwitch(appearance, 'fill-screen', _('Fill the screen'),
            _('Zoom and crop instead of showing black bars on screens that are not 16:9'));
        addSwitch(appearance, 'show-captions', _('Captions'),
            _('The file name, or the entry in the folder\'s captions.json'));
        addSwitch(appearance, 'show-clock', _('Date and time'));

        // ── Test ──
        const test = new Adw.PreferencesGroup();
        page.add(test);
        const testRow = new Adw.ActionRow({
            title: _('Test the screensaver'),
            subtitle: _('Starts it now. Move the mouse or press a key to stop.'),
        });
        const testButton = new Gtk.Button({label: _('Start Now'), valign: Gtk.Align.CENTER});
        testButton.connect('clicked', () => {
            // The screensaver runs inside GNOME Shell, not in this window's process.
            Gio.DBus.session.call(
                BUS_NAME, OBJECT_PATH, INTERFACE, 'Start', null, null,
                Gio.DBusCallFlags.NO_AUTO_START, 3000, null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (e) {
                        console.warn('[AerialScreensaver] Start failed:', e.message);
                        window.add_toast(new Adw.Toast({
                            title: _('Not loaded yet. Log out and back in, then try again.'),
                            timeout: 8,
                        }));
                    }
                });
        });
        testRow.add_suffix(testButton);
        testRow.activatable_widget = testButton;
        test.add(testRow);
    }
}
