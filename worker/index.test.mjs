import test from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from './index.js';
import handler from './index.js';

const response = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
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
    // alert deadline to (second start + grace). With a nightly run and a
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

test('a missing freshness URL degrades quietly rather than failing the run', async () => {
    const partial = { ...env, HEALTHCHECKS_PING_URL: undefined };
    const urls = [];

    const uuid = await runDaily(partial, async (url, init) => {
        urls.push(url);
        if (url === partial.DEPLOY_HOOK_URL) {
            return response(200, { result: { build_uuid: 'build-789' } });
        }
        return response(200);
    });

    assert.equal(uuid, 'build-789');
    assert.deepEqual(urls, [
        'https://builds.example/hook',
        'https://hc.example/heartbeat?rid=build-789'
    ]);
});

test('fetch handler returns 404 for unknown paths', async () => {
    const res = await handler.fetch(new Request('https://example.com/'));
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '');
});

test('fetch handler returns 404 for arbitrary bot paths', async () => {
    for (const path of ['/wp-login.php', '/admin', '/.env', '/random-bot-path']) {
        const res = await handler.fetch(new Request(`https://example.com${path}`));
        assert.equal(res.status, 404);
    }
});

test('fetch handler does not throw — no Worker exception for unknown paths', async () => {
    const res = await handler.fetch(new Request('https://example.com/anything'));
    assert.equal(res.status, 404);
});

test('recovery re-arms a stale trigger and runs one catch-up build', async () => {
    const requests = [];
    const recoveryEnv = {
        ...env,
        RECOVERY_TOKEN: 'recovery-secret',
        CLOUDFLARE_SCHEDULE_TOKEN: 'schedule-secret'
    };
    const scheduleUrl = 'https://api.cloudflare.com/client/v4/accounts/b43256ec662caecc5ffa2e8315b465ef/workers/scripts/pragma-publications/schedules';
    const { recover } = await import('./index.js');
    const uuid = await recover(recoveryEnv, async (url, init) => {
        requests.push([url, init.method]);
        if (url === scheduleUrl && init.method === 'PUT') return response(200, {
            success: true, result: { schedules: [{ cron: '30 2 * * *' }] }
        });
        if (url === scheduleUrl) return response(200, {
            success: true, result: { schedules: [] }
        });
        if (url === env.DEPLOY_HOOK_URL) return response(200, { result: { build_uuid: 'recovery-123' } });
        return response(200);
    });
    assert.equal(uuid, 'recovery-123');
    assert.deepEqual(requests, [
        [scheduleUrl, undefined],
        [scheduleUrl, 'PUT'],
        [env.DEPLOY_HOOK_URL, 'POST'],
        ['https://hc.example/heartbeat?rid=recovery-123', 'GET'],
        ['https://hc.example/freshness/log?rid=recovery-123', 'GET']
    ]);
});

test('recovery does not rewrite a recently propagated correct trigger', async () => {
    const { rearmCron } = await import('./index.js');
    const scheduleUrl = 'https://api.cloudflare.com/client/v4/accounts/b43256ec662caecc5ffa2e8315b465ef/workers/scripts/pragma-publications/schedules';
    const modified = new Date(1_000_000).toISOString();
    const calls = [];
    const changed = await rearmCron({ CLOUDFLARE_SCHEDULE_TOKEN: 'schedule-secret' }, async (url, init) => {
        calls.push([url, init.method]);
        return response(200, { success: true, result: { schedules: [{
            cron: '30 2 * * *', modified_on: modified
        }] } });
    }, 1_000_000 + 5_000);
    assert.equal(changed, false);
    assert.deepEqual(calls, [[scheduleUrl, undefined]]);
});

test('recovery route conceals missing or wrong credentials', async () => {
    const recoveryEnv = { RECOVERY_TOKEN: 'recovery-secret' };
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
        const res = await handler.fetch(new Request('https://example.com/recover', {
            method: 'POST', headers
        }), recoveryEnv);
        assert.equal(res.status, 404);
    }
});
