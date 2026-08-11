import { fetchJsonWithRetry } from './fetch-json.mjs';

const normalizeBaseUrl = value => value?.replace(/\/+$/, '') || null;

export function configuredBaselineUrls(env = process.env) {
    return [...new Set([
        normalizeBaseUrl(env.BASELINE_URL),
        normalizeBaseUrl(env.BASELINE_FALLBACK_URL)
    ].filter(Boolean))];
}

/**
 * Load both baseline documents from one deployment hostname. If that hostname
 * is temporarily unreachable, try the alternate hostname for the same Worker.
 * Exhausting every configured hostname remains fatal so the publish gate never
 * falls back to a stale repository snapshot.
 */
export async function fetchBaselineWithFallback(baseUrls, {
    fetchJson = fetchJsonWithRetry,
    onFallback = message => console.warn(message)
} = {}) {
    if (!baseUrls.length) {
        throw new Error('no remote baseline URL is configured');
    }

    let lastError;

    for (let index = 0; index < baseUrls.length; index += 1) {
        const baseUrl = normalizeBaseUrl(baseUrls[index]);

        try {
            return await Promise.all([
                fetchJson(`${baseUrl}/publications.json`),
                fetchJson(`${baseUrl}/status.json`)
            ]);
        } catch (error) {
            lastError = error;
            const fallbackUrl = baseUrls[index + 1];
            if (fallbackUrl) {
                onFallback(
                    `[generate] baseline host ${baseUrl} failed: ${error.message}; `
                    + `trying ${normalizeBaseUrl(fallbackUrl)}`
                );
            }
        }
    }

    throw new Error(
        `all ${baseUrls.length} baseline hosts failed: ${lastError?.message ?? 'unknown error'}`,
        { cause: lastError }
    );
}
