#!/usr/bin/env node
// Sends the ONLY status-changing ping the freshness check ever receives.
// It runs after `wrangler deploy` has completed, so a success ping always means
// a new version is live.

import { MONITOR_PING_TIMEOUT_MS } from '../lib/config.mjs';

const pingUrl = process.env.HEALTHCHECKS_PING_URL?.replace(/\/+$/, '');
const buildUuid = process.env.WORKERS_CI_BUILD_UUID;

if (!pingUrl) {
    console.error('[deploy] HEALTHCHECKS_PING_URL build secret is not configured');
    process.exitCode = 1;
} else if (!buildUuid) {
    console.error('[deploy] WORKERS_CI_BUILD_UUID is not available');
    process.exitCode = 1;
} else {
    const url = `${pingUrl}?rid=${encodeURIComponent(buildUuid)}`;
    try {
        // Bounded: a hung monitor must not hold a completed deploy open until
        // the build container's own 20-minute cap kills it.
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(MONITOR_PING_TIMEOUT_MS)
        });
        if (!response.ok) {
            throw new Error(`Healthchecks.io returned HTTP ${response.status}`);
        }
        console.log(`[deploy] build ${buildUuid} deployed; success ping accepted`);
    } catch (error) {
        const reason = error.name === 'TimeoutError'
            ? `timed out after ${MONITOR_PING_TIMEOUT_MS}ms`
            : error.message;
        console.error(`[deploy] success ping failed: ${reason}`);
        process.exitCode = 1;
    }
}
