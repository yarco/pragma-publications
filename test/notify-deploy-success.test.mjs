import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const script = path.resolve('scripts/notify-deploy-success.mjs');

function runNotifier(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
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

test('post-deploy notifier matches success to the Workers build UUID', async t => {
    let requestUrl = null;
    const server = http.createServer((request, response) => {
        requestUrl = request.url;
        response.writeHead(200).end('OK');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const { port } = server.address();
    const buildUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: `http://127.0.0.1:${port}/check`,
        WORKERS_CI_BUILD_UUID: buildUuid
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requestUrl, `/check?rid=${buildUuid}`);
    assert.match(result.stdout, /success ping accepted/);
});

test('post-deploy notifier fails closed when its build secret is missing', async () => {
    const result = await runNotifier({
        HEALTHCHECKS_PING_URL: '',
        WORKERS_CI_BUILD_UUID: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /not configured/);
});
