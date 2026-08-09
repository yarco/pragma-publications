const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const isRetryableStatus = status => status === 429 || status >= 500;

/** Fetch JSON with bounded retries while still failing closed on exhaustion. */
export async function fetchJsonWithRetry(url, {
    fetchImpl = fetch,
    retries = 3,
    timeoutMs = 15_000,
    backoffMs = 2_000,
    onRetry = message => console.warn(message)
} = {}) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        let retryable = true;

        try {
            const target = new URL(url);
            target.searchParams.set('baseline', Date.now().toString());
            const response = await fetchImpl(target, {
                cache: 'no-store',
                signal: AbortSignal.timeout(timeoutMs)
            });

            if (response.ok) return await response.json();

            lastError = new Error(`${url} returned HTTP ${response.status}`);
            retryable = isRetryableStatus(response.status);
        } catch (error) {
            lastError = error.name === 'TimeoutError' || error.name === 'AbortError'
                ? new Error(`${url} timed out after ${timeoutMs}ms`)
                : error;
        }

        if (!retryable) throw lastError;
        if (attempt < retries) {
            onRetry(
                `[generate] baseline fetch attempt ${attempt}/${retries} failed for `
                + `${url}: ${lastError.message}; retrying`
            );
            await sleep(backoffMs * attempt);
        }
    }

    throw new Error(
        `${url} failed after ${retries} attempts: ${lastError?.message ?? 'unknown error'}`,
        { cause: lastError }
    );
}
