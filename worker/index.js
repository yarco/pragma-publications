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

    const response = await fetchImpl(env.DEPLOY_HOOK_URL, { method: 'POST' });
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
    async fetch() {
        return new Response(null, { status: 404 });
    }
};
