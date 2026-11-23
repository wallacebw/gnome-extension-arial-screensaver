// Run with: gjs -m tests/captions.test.js
import {stemOf, parseCaptionIndex, resolveCaption, textAt} from '../captions.js';

let failures = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) {
        failures++;
        print(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
    } else {
        print(`ok   ${name}`);
    }
}

// stemOf: the caption is the file name without folder or extension
check('stem strips folder and extension',
    stemOf('/nas/Amazon/Sea/A huge school of fish gather in formation.mp4'),
    'A huge school of fish gather in formation');
check('stem keeps a caption that ends with a full stop',
    stemOf('/nas/X/Bridges fan out along the Limmat River..mov'),
    'Bridges fan out along the Limmat River.');
check('stem of a name without extension', stemOf('/nas/X/noext'), 'noext');
check('stem keeps a leading dot name whole', stemOf('/nas/X/.hidden'), '.hidden');

// parseCaptionIndex: tolerant of bad input, sorts timed points
const index = parseCaptionIndex(JSON.stringify({
    version: 1,
    clips: {
        'i003_c015_sdr_4k_hevc': {title: 'Iceland', points: {'60': 'Second', '0': 'First', '15': 'Middle'}},
        'single': {title: 'Palau Jellies', points: {'0': 'Golden Jellyfish in the waters of Palau'}},
    },
}));
check('index size', index.size, 2);
check('bad json gives an empty index', parseCaptionIndex('{not json').size, 0);
check('missing clips gives an empty index', parseCaptionIndex('{"version":1}').size, 0);

// resolveCaption: indexed files use the index (case-insensitive), others use the file name
const apple = resolveCaption('/nas/Apple/Nature/I003_C015_SDR_4K_HEVC.mov', index);
check('indexed title', apple.title, 'Iceland');
check('indexed points sorted by time', apple.points.map(p => p.at), [0, 15, 60]);
const plain = resolveCaption('/nas/Robin Fourcade/Sea/Flying over rough sea at Cap Méchant, Réunion, France.m4v', index);
check('file-name caption has no title', plain.title, '');
check('file-name caption text', plain.points,
    [{at: 0, text: 'Flying over rough sea at Cap Méchant, Réunion, France'}]);

// textAt: the caption in force at a playback position
check('before first point uses the first', textAt(apple, -1), 'First');
check('at start', textAt(apple, 0), 'First');
check('between points', textAt(apple, 20.5), 'Middle');
check('exactly on a point', textAt(apple, 60), 'Second');
check('past the end', textAt(apple, 9999), 'Second');
check('non-numeric position falls back to the first', textAt(apple, null), 'First');
check('single caption', textAt(plain, 42), 'Flying over rough sea at Cap Méchant, Réunion, France');

if (failures > 0) {
    print(`${failures} failed`);
    imports.system.exit(1);
}
print('all passed');
