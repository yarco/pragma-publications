import test from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from './index.js';

const response = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
});

test('daily run queues a build and marks it started without claiming success', async () => {
    const requests = [];
    const env = {
        DEPLOY_HOOK_URL: 'https://builds.example/hook',
        HEALTHCHECKS_PING_URL: 'https://hc.example/id'
    };

    await runDaily(env, async (url, init) => {
        requests.push([url, init.method]);
        if (url === env.DEPLOY_HOOK_URL) {
            return response(200, { result: { build_uuid: 'build-123' } });
        }
        return response(200);
    });

    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/id/start?rid=build-123', 'GET']
    ]);
});

test('deploy-hook failure actively fails the dead-man monitor', async () => {
    const requests = [];
    const env = {
        DEPLOY_HOOK_URL: 'https://builds.example/hook',
        HEALTHCHECKS_PING_URL: 'https://hc.example/id'
    };

    await assert.rejects(
        runDaily(env, async (url, init) => {
            requests.push([url, init.method]);
            return response(url === env.DEPLOY_HOOK_URL ? 503 : 200);
        }),
        /503/
    );

    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/id/fail', 'GET']
    ]);
});

test('a malformed deploy-hook response is treated as failure', async () => {
    const requests = [];
    const env = {
        DEPLOY_HOOK_URL: 'https://builds.example/hook',
        HEALTHCHECKS_PING_URL: 'https://hc.example/id'
    };
    await assert.rejects(
        runDaily(env, async (url, init) => {
            requests.push([url, init.method]);
            return response(200, {});
        }),
        /build UUID/
    );
    assert.deepEqual(requests, [
        ['https://builds.example/hook', 'POST'],
        ['https://hc.example/id/fail', 'GET']
    ]);
});
