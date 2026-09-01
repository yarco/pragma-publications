// Scheduler for the daily publications refresh.
//
// Two Healthchecks checks, with deliberately different jobs:
//
//   FRESHNESS (HEALTHCHECKS_PING_URL)
//     Answers "has a refresh succeeded recently?". Only a completed deployment
//     may change its status. Everything else is a status-neutral `/log`.
//     Its long grace window is what implements the three-strike alert policy,
//     which only works if no failing run can move its deadline. Cadence is
//     three attempts a day 8h apart with an 18h grace, so it pages after the
//     third consecutive failed attempt.
//
//     Measured on the live API 2026-08-14: a second `/start` ping moves the
//     alert deadline to (second start + grace). Repeated attempts against a
//     multi-hour grace would therefore defer the alert indefinitely, so this
//     Worker must never send `/start` to the freshness check. A `/log` ping was
//     measured the same day to leave the deadline untouched.
//
//     A `/start` also does lasting damage, discovered 2026-08-25. The last one
//     this Worker ever sent — 2026-08-14T04:23:24Z, carrying `rid=<buildUuid>`
//     — opened a run that never closed, because the success ping comes from
//     the build container and carries no matching `rid`. Healthchecks held
//     that run open for eleven days: `started: true`, `next_ping` frozen at
//     the 08-14 timestamp, `status: down`, while daily success pings kept
//     arriving. A wedged check cannot report a real staleness event, so do not
//     assume a `down` freshness check with recent successes is a false alarm.
//
//     To clear it: ping success with the STUCK RUN'S OWN rid —
//     `GET https://hc-ping.com/<uuid>?rid=<rid of the orphaned /start>`. Find
//     that rid in the ping log (`/api/v3/checks/<uuid>/pings/`, look for
//     type `start`). Do this FIRST. Re-saving the check does not clear
//     `started: true`; worse, editing `grace` while a run is stuck makes
//     Healthchecks re-evaluate the frozen deadline and email a DOWN for an
//     event days old. Measured 2026-08-25: the grace edit fired a ghost DOWN
//     dated 2026-08-15, and only the rid ping actually unwedged it. If a
//     schedule or grace edit is needed too, close the run first, or mute
//     notifications before saving.
//
//   HEARTBEAT (HEARTBEAT_PING_URL)
//     Answers "did the scheduler run and did Workers Builds accept the job?".
//     Short grace, so infrastructure faults — a rotated deploy hook, a removed
//     cron trigger, a dead Worker — still page within the hour instead of
//     waiting out the freshness tolerance.

const normalizeBase = value => value?.replace(/\/+$/, '') || null;

const ACCOUNT_ID = 'b43256ec662caecc5ffa2e8315b465ef';
const SCRIPT_NAME = 'pragma-publications';
const CRON = '23 4,12,20 * * *';
const SCHEDULES_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`;
const SCHEDULE_PROPAGATION_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const DEPLOY_HOOK_TIMEOUT_MS = 30_000;

export const freshnessBase = env => normalizeBase(env.HEALTHCHECKS_PING_URL);
export const heartbeatBase = env => normalizeBase(env.HEARTBEAT_PING_URL);

export async function ping(baseUrl, {
    suffix = '',
    runId = null,
    label = 'healthchecks',
    fetchImpl = fetch
} = {}) {
    if (!baseUrl) {
        console.warn(`[scheduler] ${label} ping URL is not configured`);
        return false;
    }

    const url = runId
        ? `${baseUrl}${suffix}?rid=${encodeURIComponent(runId)}`
        : `${baseUrl}${suffix}`;

    const response = await fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
        throw new Error(`Healthchecks.io returned HTTP ${response.status}`);
    }
    return true;
}

/** Reporting must never mask the condition being reported. */
async function pingQuietly(baseUrl, options) {
    try {
        return await ping(baseUrl, options);
    } catch (error) {
        console.error(
            `[scheduler] ${options.label ?? 'healthchecks'} ping failed: ${error.message}`
        );
        return false;
    }
}

export async function triggerBuild(env, fetchImpl = fetch) {
    if (!env.DEPLOY_HOOK_URL) {
        throw new Error('DEPLOY_HOOK_URL is not configured');
    }

    const response = await fetchImpl(env.DEPLOY_HOOK_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(DEPLOY_HOOK_TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`Workers deploy hook returned HTTP ${response.status}`);
    }

    const body = await response.json();
    const buildUuid = body?.result?.build_uuid;
    if (typeof buildUuid !== 'string' || !buildUuid) {
        throw new Error('Workers deploy hook returned no build UUID');
    }

    console.log(
        `[scheduler] Workers build ${buildUuid} accepted with HTTP ${response.status}`
    );
    return buildUuid;
}

async function authorized(req, env) {
    const supplied = req.headers.get('authorization')?.match(/^Bearer[ \t]+(.+)$/i)?.[1];
    if (!supplied || !env.RECOVERY_TOKEN) return false;
    const encoder = new TextEncoder();
    const [left, right] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
        crypto.subtle.digest('SHA-256', encoder.encode(env.RECOVERY_TOKEN))
    ]);
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function parseScheduleResponse(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return null; }
}

/** Re-register the exact trigger after a missed Cloudflare Cron delivery.
 * Healthchecks calls /recover only after the heartbeat turns DOWN. Avoid
 * rewriting a recently changed trigger: Cloudflare documents up to 15 minutes
 * of propagation, and repeated PUTs would continually restart that window. */
export async function rearmCron(env, fetchImpl = fetch, now = Date.now()) {
    if (!env.CLOUDFLARE_SCHEDULE_TOKEN) throw new Error('CLOUDFLARE_SCHEDULE_TOKEN is not configured');
    const headers = { authorization: `Bearer ${env.CLOUDFLARE_SCHEDULE_TOKEN}` };
    try {
        const currentResponse = await fetchImpl(SCHEDULES_URL, { headers });
        const current = await parseScheduleResponse(currentResponse);
        const schedules = current?.result?.schedules ?? [];
        const modified = Date.parse(schedules[0]?.modified_on ?? '');
        const age = now - modified;
        if (currentResponse.ok && current?.success === true
            && schedules.length === 1 && schedules[0]?.cron === CRON
            && Number.isFinite(modified) && age >= -CLOCK_SKEW_MS
            && age < SCHEDULE_PROPAGATION_MS) return false;
    } catch {
        // Inspection is an optimization. If it fails, the PUT below can still
        // restore a missing or malformed trigger.
    }
    const response = await fetchImpl(SCHEDULES_URL, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify([{ cron: CRON }])
    });
    const result = await parseScheduleResponse(response);
    const schedules = result?.result?.schedules ?? [];
    if (!response.ok || result?.success !== true
        || schedules.length !== 1 || schedules[0]?.cron !== CRON) {
        const code = result?.errors?.[0]?.code;
        throw new Error(`cron re-arm rejected: HTTP ${response.status}${code ? ` code ${code}` : ''}`);
    }
    return true;
}

/** Healthchecks DOWN webhook. Repair the clock and run one bounded catch-up.
 * The deploy hook/build gate make a repeated same-commit build safe; returning
 * non-2xx on hook failure lets Healthchecks retry the recovery webhook. */
export async function recover(env, fetchImpl = fetch) {
    await rearmCron(env, fetchImpl);
    return runDaily(env, fetchImpl);
}

export async function runDaily(env, fetchImpl = fetch) {
    try {
        const buildUuid = await triggerBuild(env, fetchImpl);

        // The scheduler did its whole job: the build is queued. Success here is
        // about the scheduler, not about the publication data.
        await pingQuietly(heartbeatBase(env), {
            runId: buildUuid,
            label: 'heartbeat',
            fetchImpl
        });

        // Status-neutral breadcrumb on the freshness check. Without it, a run
        // that is accepted and then fails inside the build container is
        // indistinguishable from a cron that never fired.
        await pingQuietly(freshnessBase(env), {
            suffix: '/log',
            runId: buildUuid,
            label: 'freshness log',
            fetchImpl
        });

        return buildUuid;
    } catch (error) {
        // An unreachable or rejecting deploy hook is an infrastructure fault,
        // not the flaky upstream the tolerance window exists for. Fail the
        // heartbeat immediately; leave the freshness deadline alone.
        await pingQuietly(heartbeatBase(env), {
            suffix: '/fail',
            label: 'heartbeat',
            fetchImpl
        });
        await pingQuietly(freshnessBase(env), {
            suffix: '/log',
            label: 'freshness log',
            fetchImpl
        });
        throw error;
    }
}

export default {
    async scheduled(_controller, env, ctx) {
        ctx.waitUntil(runDaily(env, fetch));
    },

    // Static Assets serves known files from ./dist. Unknown paths fall through
    // here — without a controlled response, they throw Worker exceptions.
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/recover') {
            if (request.method !== 'POST' || !(await authorized(request, env))) {
                return new Response('not found\n', { status: 404 });
            }
            try {
                const buildUuid = await recover(env);
                return Response.json({ recovered: true, cron: CRON, build: buildUuid });
            } catch (error) {
                console.error(`[scheduler] recovery failed: ${error.message}`);
                return Response.json({ recovered: false, error: error.message }, { status: 502 });
            }
        }
        return new Response(null, { status: 404 });
    }
};
