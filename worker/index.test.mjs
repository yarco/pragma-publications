import test from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from './index.js';

const response = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
});

const env = {
    DEPLOY_HOOK_URL: 'https://builds.example/hook',
    HEALTHCHECKS_PING_URL: 'https://hc.example/freshness',
    HEARTBEAT_PING_URL: 'https://hc.example/heartbeat'
};

test('a queued build heartbeats and logs, but never changes freshness status', async () => {
    const requests = [];

    await runDaily(env, async (url, init) => {
        requests.push([url, init.method]);
        if (url === env.DEPLOY_HOOK_URL) {
            return response(200, { result: { build_uuid: 'build-123' } });
        }
        return response(200);
    });

    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/heartbeat?rid=build-123', 'GET'],
        ['https://hc.example/freshness/log?rid=build-123', 'GET']
    ]);
});

test('REGRESSION: no /start is ever sent to the freshness check', async () => {
    // Measured against the live API on 2026-08-14: a second /start moves the
    // alert deadline to (second start + grace). With three attempts a day and a
    // multi-hour grace, a /start on a failing run would defer the alert
    // indefinitely and the page would serve a frozen snapshot unnoticed.
    const urls = [];

    await runDaily(env, async (url, init) => {
        urls.push(url);
        if (url === env.DEPLOY_HOOK_URL) {
            return response(200, { result: { build_uuid: 'build-123' } });
        }
        return response(200);
    });

    const freshnessCalls = urls.filter(url => url.startsWith(env.HEALTHCHECKS_PING_URL));
    assert.ok(freshnessCalls.length > 0, 'freshness check should still receive a breadcrumb');
    for (const url of freshnessCalls) {
        assert.ok(!url.includes('/start'), `freshness check must not receive /start: ${url}`);
        assert.ok(url.includes('/log'), `freshness pings must be status-neutral: ${url}`);
    }
});

test('a rejected deploy hook fails the heartbeat, not the freshness deadline', async () => {
    const requests = [];

    await assert.rejects(
        runDaily(env, async (url, init) => {
            requests.push([url, init.method]);
            return response(url === env.DEPLOY_HOOK_URL ? 503 : 200);
        }),
        /503/
    );

    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/heartbeat/fail', 'GET'],
        ['https://hc.example/freshness/log', 'GET']
    ]);
});

test('a malformed deploy-hook response is treated as an infrastructure failure', async () => {
    const requests = [];

    await assert.rejects(
        runDaily(env, async (url, init) => {
            requests.push([url, init.method]);
            return response(200, {});
        }),
        /build UUID/
    );

    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/heartbeat/fail', 'GET'],
        ['https://hc.example/freshness/log', 'GET']
    ]);
});

test('REGRESSION: a failing monitor ping never masks the underlying fault', async () => {
    // The scheduler must still surface a broken deploy hook even when
    // Healthchecks itself is unreachable.
    await assert.rejects(
        runDaily(env, async url => {
            if (url === env.DEPLOY_HOOK_URL) return response(503);
            throw new Error('monitor unreachable');
        }),
        /503/
    );
});

test('a missing heartbeat URL degrades quietly rather than failing the run', async () => {
    const partial = { ...env, HEARTBEAT_PING_URL: undefined };
    const urls = [];

    const uuid = await runDaily(partial, async (url, init) => {
        urls.push(url);
        if (url === partial.DEPLOY_HOOK_URL) {
            return response(200, { result: { build_uuid: 'build-456' } });
        }
        return response(200);
    });

    assert.equal(uuid, 'build-456');
    assert.deepEqual(urls, [
        'https://builds.example/hook',
        'https://hc.example/freshness/log?rid=build-456'
    ]);
});
