// SPDX-License-Identifier: GPL-2.0-or-later
//
// The screensaver's D-Bus control interface. The extension exports it on the
// Shell's own bus name; the preferences window (a separate process) calls it
// for its "Start Now" button. It can also be called from a terminal:
//
//   gdbus call --session --dest org.gnome.Shell \
//       --object-path /org/gnome/Shell/Extensions/AerialScreensaver \
//       --method org.gnome.Shell.Extensions.AerialScreensaver.Start

export const BUS_NAME = 'org.gnome.Shell';
export const OBJECT_PATH = '/org/gnome/Shell/Extensions/AerialScreensaver';
export const INTERFACE = 'org.gnome.Shell.Extensions.AerialScreensaver';

export const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Start"/>
  </interface>
</node>`;
