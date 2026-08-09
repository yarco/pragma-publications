import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchJsonWithRetry } from '../lib/fetch-json.mjs';

test('REGRESSION: transient baseline network failure is retried', async () => {
    let calls = 0;
    const retries = [];
    const result = await fetchJsonWithRetry('https://example.test/status.json', {
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) throw new TypeError('fetch failed');
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        backoffMs: 0,
        onRetry: message => retries.push(message)
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    assert.equal(retries.length, 1);
});

test('non-retryable baseline HTTP status fails immediately', async () => {
    let calls = 0;
    await assert.rejects(
        fetchJsonWithRetry('https://example.test/status.json', {
            fetchImpl: async () => {
                calls += 1;
                return new Response('', { status: 404 });
            },
            backoffMs: 0,
            onRetry: () => assert.fail('404 must not retry')
        }),
        /returned HTTP 404/
    );
    assert.equal(calls, 1);
});

test('exhausted baseline retries retain the final network error', async () => {
    let calls = 0;
    await assert.rejects(
        fetchJsonWithRetry('https://example.test/status.json', {
            fetchImpl: async () => {
                calls += 1;
                throw new TypeError('socket unavailable');
            },
            retries: 3,
            backoffMs: 0,
            onRetry: () => {}
        }),
        /failed after 3 attempts: socket unavailable/
    );
    assert.equal(calls, 3);
});
