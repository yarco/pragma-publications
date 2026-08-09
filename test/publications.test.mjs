import test from 'node:test';
import assert from 'node:assert/strict';

import { deduplicatePublications } from '../lib/publications.mjs';

const record = (key, label) => ({
    label,
    getAttribute(name) {
        return name === 'key' ? key : null;
    }
});

test('REGRESSION: overlapping DBLP profile feeds deduplicate by record key', () => {
    const first = record('conf/example/Paper', 'first profile');
    const duplicate = record('conf/example/Paper', 'coauthor profile');
    const distinctVersion = record('journals/corr/Paper', 'preprint');

    assert.deepEqual(
        deduplicatePublications([first, duplicate, distinctVersion]),
        [first, distinctVersion]
    );
});

test('records without a DBLP key are preserved rather than guessed duplicates', () => {
    const first = record(null, 'one');
    const second = record(null, 'two');
    assert.deepEqual(deduplicatePublications([first, second]), [first, second]);
});
