// SPDX-License-Identifier: GPL-2.0-or-later
//
// Caption lookup for Aerial Screensaver. Pure JavaScript with no GNOME
// imports, so it can be unit-tested with `gjs -m tests/captions.test.js`.
//
// A clip's caption is its file name, unless the collection's captions.json
// lists the file (Apple clips keep Apple's file names and have captions that
// change during the clip).

/** File name without folder or extension: the caption shown for most clips. */
export function stemOf(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Parse captions.json into Map(lower-case file stem -> {title, points}).
 * points is [{at: seconds, text}], sorted by time. Bad input gives an empty map.
 */
export function parseCaptionIndex(jsonText) {
    const index = new Map();
    let clips;
    try {
        clips = JSON.parse(jsonText)?.clips;
    } catch (_e) {
        return index;
    }
    if (!clips || typeof clips !== 'object')
        return index;

    for (const [stem, entry] of Object.entries(clips)) {
        const points = Object.entries(entry?.points ?? {})
            .map(([at, text]) => ({at: Number(at), text: String(text)}))
            .filter(p => Number.isFinite(p.at) && p.text !== '')
            .sort((a, b) => a.at - b.at);
        if (points.length > 0)
            index.set(stem.toLowerCase(), {title: String(entry.title ?? ''), points});
    }
    return index;
}

/** The caption for a file: its captions.json entry, or else its file name. */
export function resolveCaption(path, index) {
    const stem = stemOf(path);
    return index.get(stem.toLowerCase()) ?? {title: '', points: [{at: 0, text: stem}]};
}

/** The caption text in force at a playback position (seconds). */
export function textAt(caption, seconds) {
    const position = Number.isFinite(seconds) ? seconds : 0;
    let text = caption.points[0].text;
    for (const point of caption.points) {
        if (point.at > position)
            break;
        text = point.text;
    }
    return text;
}
