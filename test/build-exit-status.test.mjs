// Shell-level integration tests for the failure branch in package.json.
//
// The build and deploy scripts are wrapped as
//   (real work) || (node scripts/notify-failure.mjs <stage>; exit 1)
// so a failure is reported before the non-zero status propagates. If that
// propagation ever broke, a failed build would look successful and Workers
// Builds would run the deploy command against a stale or missing dist/.
// That is the single most expensive regression available here, so it is pinned
// against the real shell rather than mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'fs';
import os from 'node:os';
import path from 'node:path';

const FAILURE_BRANCH = '(node notify-stub.mjs; exit 1)';

// The behavioural tests below run a fixture package.json, so on their own they
// would keep passing if the real scripts ever drifted away from the shape they
// prove safe. Pin the real strings too.
test('the real build and deploy scripts still use the guarded failure branch', async () => {
    const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));

    for (const [script, stage] of [['build', 'build'], ['deploy:production', 'deploy']]) {
        const command = pkg.scripts[script];
        assert.ok(command, `package.json must define ${script}`);
        assert.ok(
            command.includes(`|| (node scripts/notify-failure.mjs ${stage}; exit 1)`),
            `${script} must report failure and then exit non-zero, got: ${command}`
        );
        // `&&` before exit 1 would let a crashing notifier swallow the failure.
        assert.ok(
            !command.includes('notify-failure.mjs') || !command.includes('&& exit 1'),
            `${script} must use ';' not '&&' before exit 1, got: ${command}`
        );
    }
});

async function makeWorkspace(t, scripts) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pragma-build-exit-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'exit-fixture', private: true, scripts }, null, 2),
        'utf8'
    );
    return dir;
}

function runScript(cwd, script) {
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['run', script], {
            cwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => { out += c; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, out }));
    });
}

const okStub = 'console.error("[stub] notifier ran");';
const crashingStub = 'throw new Error("notifier itself is broken");';

test('a failure inside npm test exits non-zero, notifies, and never runs generate', async t => {
    const dir = await makeWorkspace(t, {
        test: 'node -e "process.exit(1)"',
        generate: 'node -e "console.log(\'GENERATE-RAN\')"',
        build: `(npm test && npm run generate) || ${FAILURE_BRANCH}`
    });
    await fs.writeFile(path.join(dir, 'notify-stub.mjs'), okStub, 'utf8');

    const { code, out } = await runScript(dir, 'build');

    assert.equal(code, 1, 'a failing test must fail the build');
    assert.match(out, /\[stub\] notifier ran/);
    assert.doesNotMatch(out, /GENERATE-RAN/, 'generate must not run after failing tests');
});

test('a failure inside generate exits non-zero and notifies', async t => {
    const dir = await makeWorkspace(t, {
        test: 'node -e "console.log(\'tests ok\')"',
        generate: 'node -e "process.exit(1)"',
        build: `(npm test && npm run generate) || ${FAILURE_BRANCH}`
    });
    await fs.writeFile(path.join(dir, 'notify-stub.mjs'), okStub, 'utf8');

    const { code, out } = await runScript(dir, 'build');

    assert.equal(code, 1);
    assert.match(out, /\[stub\] notifier ran/);
});

test('REGRESSION: a broken notifier still leaves the build failed', async t => {
    // `;` rather than `&&` before exit 1 is what makes this hold. With `&&`,
    // a crashing notifier would swallow the failure and the build would
    // report success.
    const dir = await makeWorkspace(t, {
        test: 'node -e "process.exit(1)"',
        build: `(npm test) || ${FAILURE_BRANCH}`
    });
    await fs.writeFile(path.join(dir, 'notify-stub.mjs'), crashingStub, 'utf8');

    const { code } = await runScript(dir, 'build');

    assert.equal(code, 1, 'reporting failure must never launder a failed build into success');
});

test('a deploy whose success ping fails is still a failed run', async t => {
    // If wrangler deploys but the success ping never lands, the freshness check
    // will not see a success. Exiting non-zero keeps the build record honest.
    const dir = await makeWorkspace(t, {
        'deploy:production': `(node -e "console.log('deployed')" && node -e "process.exit(1)") || ${FAILURE_BRANCH}`
    });
    await fs.writeFile(path.join(dir, 'notify-stub.mjs'), okStub, 'utf8');

    const { code, out } = await runScript(dir, 'deploy:production');

    assert.equal(code, 1);
    assert.match(out, /deployed/);
    assert.match(out, /\[stub\] notifier ran/);
});

test('a fully successful build exits zero and does not notify', async t => {
    const dir = await makeWorkspace(t, {
        test: 'node -e "console.log(\'tests ok\')"',
        generate: 'node -e "console.log(\'GENERATE-RAN\')"',
        build: `(npm test && npm run generate) || ${FAILURE_BRANCH}`
    });
    await fs.writeFile(path.join(dir, 'notify-stub.mjs'), okStub, 'utf8');

    const { code, out } = await runScript(dir, 'build');

    assert.equal(code, 0);
    assert.match(out, /GENERATE-RAN/);
    assert.doesNotMatch(out, /\[stub\] notifier ran/);
});
