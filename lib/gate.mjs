import {
    MIN_SELECTED_PUBLICATIONS,
    MIN_TOTAL_RETENTION_RATIO,
    MIN_SELECTED_RETENTION_RATIO,
    MIN_BASELINE_RETENTION_RATIO,
    ALLOW_SHRINK
} from './config.mjs';
import { countPublications } from './publications.mjs';

const selectedCount = data => (Array.isArray(data?.selected) ? data.selected.length : 0);

export function isWellFormed(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.selected)) return false;
    return countPublications(data) > 0;
}

/** Reject a candidate that would make the published page worse. */
export function evaluateCandidate(candidate, previous, priorBaseline = null, options = {}) {
    const allowShrink = options.allowShrink ?? ALLOW_SHRINK;

    if (!candidate || typeof candidate !== 'object') {
        return { ok: false, reason: 'candidate is not an object' };
    }
    if (!Array.isArray(candidate.selected)) {
        return { ok: false, reason: 'candidate has no selected array' };
    }

    const candidateSelected = selectedCount(candidate);
    const candidateTotal = countPublications(candidate);

    if (candidateSelected < MIN_SELECTED_PUBLICATIONS) {
        return {
            ok: false,
            reason: `selected list is empty (min ${MIN_SELECTED_PUBLICATIONS}); `
                + 'the webpage scrape probably broke silently'
        };
    }
    if (candidateTotal === 0) {
        return { ok: false, reason: 'candidate contains no publications' };
    }

    if (allowShrink) {
        return { ok: true, reason: 'shrink explicitly allowed via ALLOW_SHRINK', shrinkAllowed: true };
    }

    const checks = [];
    if (previous) {
        checks.push({
            label: 'total vs previous',
            actual: candidateTotal,
            floor: countPublications(previous) * MIN_TOTAL_RETENTION_RATIO,
            was: countPublications(previous)
        });
        checks.push({
            label: 'selected vs previous',
            actual: candidateSelected,
            floor: selectedCount(previous) * MIN_SELECTED_RETENTION_RATIO,
            was: selectedCount(previous)
        });
    }
    if (priorBaseline) {
        checks.push({
            label: 'total vs high-water',
            actual: candidateTotal,
            floor: (priorBaseline.maxTotal ?? 0) * MIN_BASELINE_RETENTION_RATIO,
            was: priorBaseline.maxTotal ?? 0
        });
        checks.push({
            label: 'selected vs high-water',
            actual: candidateSelected,
            floor: (priorBaseline.maxSelected ?? 0) * MIN_BASELINE_RETENTION_RATIO,
            was: priorBaseline.maxSelected ?? 0
        });
    }

    for (const check of checks) {
        if (check.was > 0 && check.actual < check.floor) {
            return {
                ok: false,
                reason: `${check.label} collapsed ${check.was} -> ${check.actual} `
                    + `(below ${Math.ceil(check.floor)}); refusing to publish. `
                    + 'Set ALLOW_SHRINK=1 to accept a genuine contraction.'
            };
        }
    }

    return { ok: true, reason: null };
}
