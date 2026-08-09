#!/usr/bin/env node
// Static generator for the scheduled GitHub Actions build.
//
// Writes the Pages artifact. Applies the same publish gate as the server,
// comparing against the last committed data and its persisted high-water marks,
// so a silently broken upstream scrape exits non-zero and leaves the last good
// deployment live.

import { promises as fs } from 'fs';
import path from 'path';

import { processData, countPublications } from './lib/publications.mjs';
import { evaluateCandidate } from './lib/gate.mjs';
import { renderSuccess } from './lib/render.mjs';
import { buildStatus, deriveBaseline } from './lib/static-state.mjs';

const OUT_DIR = 'dist';
const OUT_SCRIPT = path.join(OUT_DIR, 'getPublications.js');
const OUT_DATA = path.join(OUT_DIR, 'publications.json');
const OUT_STATUS = path.join(OUT_DIR, 'status.json');
const BASELINE_URL = process.env.BASELINE_URL?.replace(/\/+$/, '') || null;
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

async function fetchJson(url) {
    const response = await fetch(`${url}?baseline=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.json();
}

async function readPrevious() {
    if (BASELINE_URL) {
        console.log(`[generate] loading publish-gate baseline from ${BASELINE_URL}`);
        // Once a production baseline is configured, failure to read it is fatal.
        // Falling back to an older repository snapshot could lower a high-water
        // mark and let a degraded candidate replace the live deployment.
        return await Promise.all([
            fetchJson(`${BASELINE_URL}/publications.json`),
            fetchJson(`${BASELINE_URL}/status.json`)
        ]);
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

main().catch(error => {
    console.error(`[generate] failed: ${error.message}`);
    process.exitCode = 1;
});
