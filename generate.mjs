#!/usr/bin/env node
// Static generator for the scheduled Cloudflare Workers Build.
//
// Writes the Worker Static Assets artifact. Applies the same publish gate as the server,
// comparing against the last committed data and its persisted high-water marks,
// so a silently broken upstream scrape exits non-zero and leaves the last good
// deployment live.

import { promises as fs } from 'fs';
import path from 'path';

import { processData, countPublications } from './lib/publications.mjs';
import { evaluateCandidate } from './lib/gate.mjs';
import { renderSuccess } from './lib/render.mjs';
import { buildStatus, deriveBaseline } from './lib/static-state.mjs';
import {
    configuredBaselineUrls,
    fetchBaselineWithFallback
} from './lib/baseline.mjs';
import {
    buildFailureReport,
    describeErrorChain,
    writeFailureReport
} from './lib/failure-report.mjs';
import { FAILURE_STAGES } from './lib/config.mjs';

const OUT_DIR = 'dist';
const OUT_SCRIPT = path.join(OUT_DIR, 'getPublications.js');
const OUT_DATA = path.join(OUT_DIR, 'publications.json');
const OUT_STATUS = path.join(OUT_DIR, 'status.json');
const BASELINE_URLS = configuredBaselineUrls();
const SOURCE = process.env.PUBLICATION_SOURCE
    || (process.env.WORKERS_CI ? 'cloudflare-worker' : 'local');

async function readJson(file) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[generate] could not read ${file}: ${error.message}`);
        }
        return null;
    }
}

async function readPrevious() {
    if (BASELINE_URLS.length) {
        console.log(
            `[generate] loading publish-gate baseline from ${BASELINE_URLS.join(' or ')}`
        );
        // Once a production baseline is configured, failure to read it is fatal.
        // Falling back to an older repository snapshot could lower a high-water
        // mark and let a degraded candidate replace the live deployment.
        return await fetchBaselineWithFallback(BASELINE_URLS);
    }

    return await Promise.all([
        readJson(OUT_DATA),
        readJson(OUT_STATUS)
    ]);
}

async function main() {
    const startedAt = Date.now();
    const [previous, previousStatus] = await readPrevious();
    const priorBaseline = deriveBaseline(previous, previousStatus);

    const data = await processData();
    const verdict = evaluateCandidate(data, previous, priorBaseline);

    if (!verdict.ok) {
        console.error(`[generate] PUBLISH GATE REJECTED: ${verdict.reason}`);
        console.error('[generate] leaving the previously published file untouched');
        // A gate rejection is deterministic: retrying will not repair a scraper
        // pinned to class names Google has reshuffled. It shares the tolerance
        // window with transient faults, so name it precisely for triage.
        await writeFailureReport(buildFailureReport({
            stage: FAILURE_STAGES.BUILD,
            reason: `publish gate rejected: ${verdict.reason}`
        }));
        process.exitCode = 1;
        return;
    }

    const generatedAt = new Date().toISOString();
    const totalPublications = countPublications(data);
    const status = buildStatus(data, priorBaseline, generatedAt, SOURCE);
    const selectedPublications = status.selectedPublications;

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(OUT_DATA, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.writeFile(
        OUT_SCRIPT,
        renderSuccess(data, { generatedAt, source: SOURCE }),
        'utf8'
    );
    await fs.writeFile(OUT_STATUS, `${JSON.stringify(status, null, 2)}\n`, 'utf8');

    const bytes = (await fs.stat(OUT_SCRIPT)).size;
    console.log(
        `[generate] ok in ${Date.now() - startedAt}ms: `
        + `${totalPublications} publications, ${selectedPublications} selected, `
        + `${(bytes / 1024).toFixed(1)} KB -> ${OUT_SCRIPT}`
    );
}

main().catch(async error => {
    // Print the whole cause chain. `error.message` alone reduced the
    // 2026-08-14 connection failure to a bare "fetch failed", which could not
    // be told apart from a DNS failure without re-running the pipeline.
    console.error(`[generate] failed: ${describeErrorChain(error)}`);
    await writeFailureReport(buildFailureReport({
        stage: FAILURE_STAGES.BUILD,
        reason: 'generate threw',
        error
    }));
    process.exitCode = 1;
});
