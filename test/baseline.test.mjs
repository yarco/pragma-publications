import test from 'node:test';
import assert from 'node:assert/strict';

import {
    configuredBaselineUrls,
    fetchBaselineWithFallback
} from '../lib/baseline.mjs';

test('configured baseline URLs are normalized and deduplicated', () => {
    assert.deepEqual(
        configuredBaselineUrls({
            BASELINE_URL: 'https://primary.example/',
            BASELINE_FALLBACK_URL: 'https://primary.example'
        }),
        ['https://primary.example']
    );
});

test('REGRESSION: alternate Worker hostname survives a failed primary baseline host', async () => {
    const requests = [];
    const warnings = [];
    const fetchJson = async url => {
        requests.push(url);
        if (url.startsWith('https://primary.example/')) {
            throw new TypeError('fetch failed');
        }
        return url.endsWith('/status.json') ? { ok: true } : { selected: [] };
    };

    const result = await fetchBaselineWithFallback(
        ['https://primary.example', 'https://fallback.example/'],
        { fetchJson, onFallback: message => warnings.push(message) }
    );

    assert.deepEqual(result, [{ selected: [] }, { ok: true }]);
    assert.deepEqual(requests, [
        'https://primary.example/publications.json',
        'https://primary.example/status.json',
        'https://fallback.example/publications.json',
        'https://fallback.example/status.json'
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /trying https:\/\/fallback\.example/);
});

test('all configured baseline hosts failing remains fatal', async () => {
    await assert.rejects(
        fetchBaselineWithFallback(
            ['https://primary.example', 'https://fallback.example'],
            {
                fetchJson: async url => {
                    throw new Error(`${url} unavailable`);
                },
                onFallback: () => {}
            }
        ),
        /all 2 baseline hosts failed/
    );
});
