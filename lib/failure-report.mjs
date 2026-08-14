import { promises as fs } from 'fs';

import { FAILURE_REPORT_FILE, FAILURE_REPORT_MAX_CHARS } from './config.mjs';

/**
 * Node reports connection-layer problems as a bare `TypeError: fetch failed`
 * and hides the real errno on `error.cause`. The 2026-08-14 incident logged
 * only `error.message`, so the build record could not distinguish a DNS failure
 * from a connection reset. Walk the whole chain instead.
 */
export function describeErrorChain(error, maxDepth = 5) {
    const parts = [];
    let current = error;

    for (let depth = 0; depth < maxDepth && current; depth += 1) {
        const name = current.name || 'Error';
        const message = current.message || String(current);
        const code = current.code ? ` [${current.code}]` : '';
        const errno = current.errno !== undefined ? ` errno=${current.errno}` : '';
        const syscall = current.syscall ? ` syscall=${current.syscall}` : '';
        const host = current.hostname ? ` host=${current.hostname}` : '';
        parts.push(`${name}: ${message}${code}${errno}${syscall}${host}`);
        current = current.cause;
    }

    if (current) parts.push('… cause chain truncated');
    return parts.join(' <- ');
}

/** Clamp anything bound for a ping body; a monitor event is not a log sink. */
export function boundText(text, maxChars = FAILURE_REPORT_MAX_CHARS) {
    const value = String(text ?? '');
    return value.length <= maxChars
        ? value
        : `${value.slice(0, maxChars - 1)}…`;
}

export function buildFailureReport({
    stage,
    reason,
    error = null,
    buildUuid = process.env.WORKERS_CI_BUILD_UUID ?? null
}) {
    return {
        schemaVersion: 1,
        // Scope the report to the run that wrote it. A reused build workspace,
        // or a local run, can leave a previous failure on disk; without this
        // the notifier would confidently report the wrong cause.
        buildUuid,
        stage,
        reason,
        detail: error ? boundText(describeErrorChain(error)) : null,
        failedAt: new Date().toISOString()
    };
}

/**
 * The build container is the only place that knows why a run failed, and it is
 * also the thing that just failed. Persist the reason so the separate notifier
 * process can report it even though the failing step already exited.
 */
export async function writeFailureReport(report, file = FAILURE_REPORT_FILE) {
    try {
        await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
        // Never let reporting failure mask the original failure.
        console.error(`[failure-report] could not write ${file}: ${error.message}`);
    }
}

/**
 * Read a report only if it belongs to the run asking for it. A mismatched or
 * unreadable report yields null, so the caller reports "no report written"
 * rather than an older run's cause chain.
 */
export async function readFailureReport(
    file = FAILURE_REPORT_FILE,
    { buildUuid = process.env.WORKERS_CI_BUILD_UUID ?? null } = {}
) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        // A report written without a build UUID (a local run) is only trusted
        // when the reader has no build UUID either. Note the deliberate limit:
        // two local runs both write a null owner, so they are not isolated from
        // each other. That only ever misattributes a cause in a developer's
        // terminal - in Workers Builds every run has a UUID - and it cannot
        // change the freshness check's status or suppress an alert.
        const owner = parsed.buildUuid ?? null;
        return owner === (buildUuid ?? null) ? parsed : null;
    } catch {
        return null;
    }
}

/** Clear any leftover report so a later stage cannot inherit it. */
export async function clearFailureReport(file = FAILURE_REPORT_FILE) {
    try {
        await fs.rm(file, { force: true });
    } catch {
        // A report we cannot remove is not worth failing a build over; the
        // build-UUID check above is the actual guard against stale data.
    }
}
