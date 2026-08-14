import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'node:os';
import path from 'node:path';

import {
    describeErrorChain,
    boundText,
    buildFailureReport,
    writeFailureReport,
    readFailureReport
} from '../lib/failure-report.mjs';

test('the cause chain is unwrapped, not reduced to the outer message', () => {
    // This is the exact shape of the 2026-08-14 incident: undici raises a bare
    // "fetch failed" and hides the real errno on .cause. Logging only
    // error.message could not distinguish DNS failure from connection reset.
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN dblp.org'), {
        code: 'EAI_AGAIN',
        errno: -3001,
        syscall: 'getaddrinfo',
        hostname: 'dblp.org'
    });
    const error = Object.assign(new TypeError('fetch failed'), { cause });

    const described = describeErrorChain(error);

    assert.match(described, /TypeError: fetch failed/);
    assert.match(described, /EAI_AGAIN/);
    assert.match(described, /syscall=getaddrinfo/);
    assert.match(described, /host=dblp.org/);
});

test('a cyclic or very deep cause chain terminates', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;

    const described = describeErrorChain(a);

    assert.ok(described.length < 2_000);
    assert.match(described, /truncated/);
});

test('an error without a cause still describes itself', () => {
    assert.match(describeErrorChain(new Error('plain')), /Error: plain/);
});

test('ping bodies are bounded so a monitor event cannot become a log dump', () => {
    const bounded = boundText('x'.repeat(10_000), 100);
    assert.equal(bounded.length, 100);
    assert.ok(bounded.endsWith('…'));
});

test('a gate rejection is reported with its reason and no error chain', () => {
    const report = buildFailureReport({
        stage: 'build',
        reason: 'publish gate rejected: selected list is empty'
    });

    assert.equal(report.stage, 'build');
    assert.match(report.reason, /selected list is empty/);
    assert.equal(report.detail, null);
    assert.ok(Date.parse(report.failedAt) > 0);
});

test('a failure report round-trips through disk for the separate notifier process', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pragma-failure-'));
    const file = path.join(dir, 'report.json');
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    const report = buildFailureReport({
        stage: 'build',
        reason: 'generate threw',
        error: new Error('boom')
    });
    await writeFailureReport(report, file);

    assert.deepEqual(await readFailureReport(file), report);
});

test('a missing or corrupt report reads as null rather than throwing', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pragma-failure-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    assert.equal(await readFailureReport(path.join(dir, 'absent.json')), null);

    const corrupt = path.join(dir, 'corrupt.json');
    await fs.writeFile(corrupt, '{not json', 'utf8');
    assert.equal(await readFailureReport(corrupt), null);
});
