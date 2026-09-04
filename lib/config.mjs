// Single source of truth for every tunable. No magic numbers elsewhere.

export const DBLP_PROFILES = Object.freeze([
    { pid: '163/1540', name: 'Youngseok Yang' },
    { pid: '88/10578', name: 'Yaroslav Hayduk' },
    { pid: '09/2790', name: 'Myeongjae Jeon' }
]);

// DBLP source. `name` is the SPARQL primaryCreatorName for that PID, not a
// hoped-for faculty label. Query uses pid only. Daily SPARQL sync is enough
// for a static snapshot. Person-page XML feeds are not used.
export const DBLP_SPARQL_ENDPOINT = 'https://sparql.dblp.org/sparql';
export const DBLP_PERSON_URI_PREFIX = 'https://dblp.org/pid/';

export const WEBPAGE_URL = 'https://sites.google.com/site/myeongjae/';

export const SHUFFLE_SEED = 'my-unique-seed-for-shuffling';

// SPARQL is usually sub-second to a few seconds. The timeout stays generous
// because the endpoint is still a public beta with rate limits; retries back
// off rather than hammering a 429/503.
export const FETCH_TIMEOUT_MS = 45_000;
export const FETCH_RETRIES = 3;
export const FETCH_BACKOFF_MS = 5_000;

// Identify ourselves. An anonymous client is the first thing a rate limiter drops.
export const USER_AGENT =
    'pragma-publications/2.0 (+https://www.pragma.ooo/research; contact: yarcoh@gmail.com)';

// Publish gate. A refresh may never replace a good result with a degraded one:
// the Google Sites scraper is pinned to obfuscated class names and fails silently.
export const MIN_SELECTED_PUBLICATIONS = 1;
export const MIN_TOTAL_RETENTION_RATIO = 0.5;

// The `selected` list needs its own retention check. Counting only the DBLP
// year buckets misses the exact failure this gate exists for: the Google Sites
// scraper degrading from 40 entries to 1 while DBLP stays perfectly healthy.
export const MIN_SELECTED_RETENTION_RATIO = 0.5;

// Ratios compare against the previous run, so repeated halvings (69 -> 35 -> 18)
// would each pass. High-water marks close that ratchet.
export const MIN_BASELINE_RETENTION_RATIO = 0.5;

// Escape hatch for a genuine contraction (an author profile really did shrink).
// Without it the gate would reject the truth forever with no way to accept it.
// It also skips the baseline fetch entirely, which is what a from-scratch
// bootstrap needs: nothing is published yet, so there is nothing to compare
// against and the high-water marks start at the candidate's own values.
export const ALLOW_SHRINK = process.env.ALLOW_SHRINK === '1';

// Publish-gate baseline for runs that set neither BASELINE_URL nor
// BASELINE_FALLBACK_URL — in practice a local `npm run deploy`. Both hostnames
// serve the same live deployment, so a local build gates against exactly what
// production serves. Workers Builds sets the env variants to the same origins.
export const DEFAULT_BASELINE_URLS = Object.freeze([
    'https://pragma-publications.pragma-publications.workers.dev',
    'https://redesignmypage.com'
]);

// Failure reporting. The refresh now tolerates two consecutive failures before
// it alerts, so the forensic trail is the only record of the two that pass
// silently. `/log` events must stay small: a monitor is not a log sink.
export const FAILURE_REPORT_FILE = '.failure-report.json';
export const FAILURE_REPORT_MAX_CHARS = 1_500;

// Monitor pings need their own deadline. A stalled success ping after a healthy
// `wrangler deploy` would otherwise hold the build open against the 20-minute
// cap and leave the deployment unrecorded, which later reads as a failed run.
// This is the same defect the DBLP fetches originally had.
export const MONITOR_PING_TIMEOUT_MS = 10_000;

// Reason codes carried in the `/log` body. A gate rejection is deterministic
// and will not self-heal; a fetch failure usually does. The alert policy treats
// them alike by design, so the reason has to be legible at triage time.
export const FAILURE_STAGES = Object.freeze({
    BUILD: 'build',
    DEPLOY: 'deploy'
});
