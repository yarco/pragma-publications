import { countPublications } from './publications.mjs';

export const selectedCount = data => (Array.isArray(data?.selected) ? data.selected.length : 0);

/**
 * Restore the gate's high-water marks for a stateless build.
 *
 * The previous data is included as a fallback for the first deployment that
 * predates status.json, and to keep a malformed or stale status file from
 * lowering the baseline.
 */
export function deriveBaseline(previous, status) {
    const persisted = status?.baseline;
    return {
        maxTotal: Math.max(
            Number.isFinite(persisted?.maxTotal) ? persisted.maxTotal : 0,
            previous ? countPublications(previous) : 0
        ),
        maxSelected: Math.max(
            Number.isFinite(persisted?.maxSelected) ? persisted.maxSelected : 0,
            previous ? selectedCount(previous) : 0
        )
    };
}

export function buildStatus(data, priorBaseline, generatedAt, source = 'github-actions') {
    const totalPublications = countPublications(data);
    const selectedPublications = selectedCount(data);

    return {
        schemaVersion: 1,
        ok: true,
        generatedAt,
        source,
        totalPublications,
        selectedPublications,
        baseline: {
            maxTotal: Math.max(priorBaseline?.maxTotal ?? 0, totalPublications),
            maxSelected: Math.max(priorBaseline?.maxSelected ?? 0, selectedPublications)
        }
    };
}
