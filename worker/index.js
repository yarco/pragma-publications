function healthchecksUrl(env, suffix = '') {
    const base = env.HEALTHCHECKS_PING_URL?.replace(/\/+$/, '');
    return base ? `${base}${suffix}` : null;
}

export async function pingHealthchecks(
    env,
    suffix = '',
    runId = null,
    fetchImpl = fetch
) {
    const baseUrl = healthchecksUrl(env, suffix);
    const url = baseUrl && runId
        ? `${baseUrl}?rid=${encodeURIComponent(runId)}`
        : baseUrl;
    if (!url) {
        console.warn('[scheduler] HEALTHCHECKS_PING_URL is not configured');
        return;
    }

    const response = await fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
        throw new Error(`Healthchecks.io returned HTTP ${response.status}`);
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

        // The deploy hook only queues an asynchronous build. Mark this run as
        // started, never successful: the Workers Builds deploy command sends
        // the matching success ping after `wrangler deploy` finishes. If build,
        // generation, or deployment fails, Healthchecks expires the started run.
        await pingHealthchecks(env, '/start', buildUuid, fetchImpl).catch(error => {
            console.error(`[scheduler] start ping failed: ${error.message}`);
        });

        return buildUuid;
    } catch (error) {
        await pingHealthchecks(env, '/fail', null, fetchImpl).catch(pingError => {
            console.error(`[scheduler] failure ping failed: ${pingError.message}`);
        });
        throw error;
    }
}

export default {
    async scheduled(_controller, env, ctx) {
        ctx.waitUntil(runDaily(env, fetch));
    }
};
