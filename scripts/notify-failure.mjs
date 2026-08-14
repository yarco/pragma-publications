#!/usr/bin/env node
// Build-side failure reporter.
//
// The Worker's scheduled() handler stops observing once the deploy hook is
// accepted, and notify-deploy-success.mjs only runs after a successful deploy.
// Before this script existed, nothing was in a position to report *why* a build
// failed: the monitor saw only an absent success ping, which is the same
// evidence as a cron that never fired.
//
// This sends a Healthchecks `/log` event. `/log` is verified not to change the
// check's status or move its alert deadline, so reporting a failure here can
// never trip — or defer — the three-strike alert policy.

import { readFailureReport, boundText } from '../lib/failure-report.mjs';
import { FAILURE_STAGES } from '../lib/config.mjs';

const VALID_STAGES = new Set(Object.values(FAILURE_STAGES));

function resolveStage(argv) {
    const requested = argv[2];
    return VALID_STAGES.has(requested) ? requested : FAILURE_STAGES.BUILD;
}

function buildBody({ stage, buildUuid, report }) {
    const lines = [
        `stage=${stage}`,
        `build=${buildUuid ?? 'unknown'}`,
        `reason=${report?.reason ?? 'no failure report written; step exited before reporting'}`
    ];
    if (report?.detail) lines.push(`detail=${report.detail}`);
    if (report?.failedAt) lines.push(`failedAt=${report.failedAt}`);
    return boundText(lines.join('\n'));
}

async function main() {
    const stage = resolveStage(process.argv);
    const pingUrl = process.env.HEALTHCHECKS_PING_URL?.replace(/\/+$/, '');
    const buildUuid = process.env.WORKERS_CI_BUILD_UUID;

    if (!pingUrl) {
        // Deliberately not fatal. This process only runs because the build has
        // already failed; masking that failure with a reporting error would
        // lose the real exit status.
        console.error('[failure] HEALTHCHECKS_PING_URL is not configured; nothing reported');
        return;
    }

    const report = await readFailureReport();
    const body = buildBody({ stage, buildUuid, report });
    const url = buildUuid
        ? `${pingUrl}/log?rid=${encodeURIComponent(buildUuid)}`
        : `${pingUrl}/log`;

    try {
        // POST, not GET: a GET cannot carry the cause chain as a body.
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body
        });
        if (!response.ok) {
            throw new Error(`Healthchecks.io returned HTTP ${response.status}`);
        }
        console.error(`[failure] reported ${stage} failure to the monitor log`);
    } catch (error) {
        console.error(`[failure] could not report failure: ${error.message}`);
    }
}

await main();
