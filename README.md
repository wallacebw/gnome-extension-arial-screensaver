# Aerial Screensaver

A GNOME Shell extension (Wayland and X11) that plays a folder tree of aerial
videos fullscreen after a period of inactivity, with each clip's caption and
the date and time drawn over the video. Any key press, click or pointer
movement dismisses it.

Ported from [Movie Screensaver](https://github.com/gilson-fonsaca/movie_screensaver)
by Gilson F. (GPL-2.0). New here: recursive folder playback, captions, clock,
fill-screen for ultrawide monitors, and GNOME 51 support.

## Requirements

- GNOME Shell 47 to 51 (developed and tested on 51)
- `mpv`

## Install

    git clone https://github.com/wallacebw/gnome-extension-arial-screensaver.git
    cd gnome-extension-arial-screensaver
    ./install.sh

On Wayland, log out and back in afterwards, then:

    gnome-extensions enable aerial-screensaver@wallacebw.github.io

The first time it is enabled without a folder set, the preferences window
opens so you can choose one. The top-bar icon has "Start Screensaver Now" and
the common switches.

To try it without waiting, use "Start Screensaver Now" in the top-bar menu or
"Start Now" at the bottom of the preferences window. The same thing from a
terminal or a keyboard shortcut:

    gdbus call --session --dest org.gnome.Shell \
        --object-path /org/gnome/Shell/Extensions/AerialScreensaver \
        --method org.gnome.Shell.Extensions.AerialScreensaver.Start

## Captions

Name your files after what they show and no other setup is needed:

- A clip's caption is its file name without the extension.
- If the videos folder contains a `captions.json`, files listed there use its
  captions instead. This is for clips whose file names are not descriptive, or
  whose caption should change while the clip plays. Each entry can also have a
  title, shown above the caption.

`captions.json` looks like this (keys are lower-case file names without extension,
`points` maps a second in the clip to the caption shown from then on):

    {"version": 1, "clips": {"i003_c015_sdr_4k_hevc": {"title": "Iceland",
      "points": {"0": "Traveling through Jökulgil in Landmannalaugar, Iceland"}}}}

## Tests

    gjs -m tests/captions.test.js

    # Whole extension in a throwaway headless Shell (see the script for options).
    # This one opens the preferences window and clicks "Start Now"; the click
    # position is for the script's 3440x1440 test monitor.
    AERIAL_TEST_CLICK="1918 1085" tests/run-headless.sh VIDEOS_FOLDER OUTPUT_DIR
