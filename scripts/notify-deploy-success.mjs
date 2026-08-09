#!/usr/bin/env node

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
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`Healthchecks.io returned HTTP ${response.status}`);
        }
        console.log(`[deploy] build ${buildUuid} deployed; success ping accepted`);
    } catch (error) {
        console.error(`[deploy] success ping failed: ${error.message}`);
        process.exitCode = 1;
    }
}
