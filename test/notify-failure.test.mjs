import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'fs';
import http from 'node:http';
import path from 'node:path';

import { FAILURE_REPORT_FILE } from '../lib/config.mjs';

const script = path.resolve('scripts/notify-failure.mjs');
const reportPath = path.resolve(FAILURE_REPORT_FILE);

function runNotifier(env, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

async function captureOnePing() {
    const received = {};
    const server = http.createServer((request, response) => {
        received.url = request.url;
        received.method = request.method;
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            received.body = Buffer.concat(chunks).toString('utf8');
            response.writeHead(200).end('OK');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, received, port: server.address().port };
}

test('a build failure is reported to /log with its reason and cause chain', async t => {
    const { server, received, port } = await captureOnePing();
    t.after(() => server.close());
    t.after(() => fs.rm(reportPath, { force: true }));

    await fs.writeFile(reportPath, JSON.stringify({
        schemaVersion: 1,
        stage: 'build',
        reason: 'generate threw',
        detail: 'TypeError: fetch failed <- Error: getaddrinfo EAI_AGAIN dblp.org [EAI_AGAIN]',
        failedAt: '2026-08-14T04:24:05.000Z'
    }), 'utf8');

    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: `http://127.0.0.1:${port}/check`,
        WORKERS_CI_BUILD_UUID: 'build-789'
    }, ['build']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.url, '/check/log?rid=build-789');
    // POST, because a GET cannot carry the cause chain.
    assert.equal(received.method, 'POST');
    assert.match(received.body, /stage=build/);
    assert.match(received.body, /reason=generate threw/);
    assert.match(received.body, /EAI_AGAIN/);
});

test('REGRESSION: the notifier pings /log, never a status-changing endpoint', async t => {
    const { server, received, port } = await captureOnePing();
    t.after(() => server.close());
    t.after(() => fs.rm(reportPath, { force: true }));

    await runNotifier({
        HEALTHCHECKS_PING_URL: `http://127.0.0.1:${port}/check`,
        WORKERS_CI_BUILD_UUID: 'build-789'
    }, ['deploy']);

    assert.ok(received.url.includes('/log'));
    assert.ok(!received.url.includes('/fail'));
    assert.ok(!received.url.includes('/start'));
});

test('a failure with no report still reports the stage rather than staying silent', async t => {
    const { server, received, port } = await captureOnePing();
    t.after(() => server.close());
    await fs.rm(reportPath, { force: true });

    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: `http://127.0.0.1:${port}/check`,
        WORKERS_CI_BUILD_UUID: 'build-789'
    }, ['deploy']);
    server.close();

    assert.equal(result.code, 0, result.stderr);
    assert.match(received.body, /stage=deploy/);
    assert.match(received.body, /no failure report written/);
});

test('an unreachable monitor does not mask the build failure it is reporting', async t => {
    t.after(() => fs.rm(reportPath, { force: true }));

    // Port 1 is reserved and refuses connections.
    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: 'http://127.0.0.1:1/check',
        WORKERS_CI_BUILD_UUID: 'build-789'
    }, ['build']);

    assert.equal(result.code, 0, 'notifier must not add its own non-zero exit');
    assert.match(result.stderr, /could not report failure/);
});

test('a missing ping URL is non-fatal for the same reason', async () => {
    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: '',
        WORKERS_CI_BUILD_UUID: 'build-789'
    }, ['build']);

    assert.equal(result.code, 0);
    assert.match(result.stderr, /nothing reported/);
});
