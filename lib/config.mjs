// Single source of truth for every tunable. No magic numbers elsewhere.

export const DBLP_PROFILES = Object.freeze([
    { pid: '163/1540', name: 'Myeongjae Jeon' },
    { pid: '88/10578', name: 'Youngjae Kim' },
    { pid: '09/2790', name: 'Sam H. Noh' }
]);

export const DBLP_URLS = Object.freeze(
    DBLP_PROFILES.map(p => `https://dblp.org/pid/${p.pid}.xml`)
);

export const WEBPAGE_URL = 'https://sites.google.com/site/myeongjae/';

export const SHUFFLE_SEED = 'my-unique-seed-for-shuffling';

// DBLP has been measured at 8-18s per profile and 503s under load, so the
// timeout is generous and retries back off rather than hammering.
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
export const ALLOW_SHRINK = process.env.ALLOW_SHRINK === '1';

// Failure reporting. The refresh now tolerates two consecutive failures before
// it alerts, so the forensic trail is the only record of the two that pass
// silently. `/log` events must stay small: a monitor is not a log sink.
export const FAILURE_REPORT_FILE = '.failure-report.json';
export const FAILURE_REPORT_MAX_CHARS = 1_500;

// Reason codes carried in the `/log` body. A gate rejection is deterministic
// and will not self-heal; a fetch failure usually does. The alert policy treats
// them alike by design, so the reason has to be legible at triage time.
export const FAILURE_STAGES = Object.freeze({
    BUILD: 'build',
    DEPLOY: 'deploy'
});
