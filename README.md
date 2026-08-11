# Pragma publications

Generates the publications data used by <https://www.pragma.ooo/research> and
publishes it as a static JavaScript file. The production design needs no VPS:
one Cloudflare Worker serves the static files, runs the daily schedule, and
triggers a Git-connected Workers Build of its next version.

The source repository is public, but GitHub Actions is deliberately not the
scheduler. GitHub documents that public-repository schedules can be silently
disabled after 60 days without repository activity; this project may legitimately
go months without a source change.

## Why it is static

The source data changes only occasionally, while DBLP is slow and intermittently
unavailable. A scheduled build fetches the three DBLP profiles and the selected-
publications page once, applies a retention gate, then publishes:

- `dist/getPublications.js` — browser payload used by the Webflow embed
- `dist/publications.json` — last accepted structured data
- `dist/status.json` — generation time, counts, and persistent high-water marks

If an upstream fetch fails or the scraper output collapses, the build exits before
`wrangler deploy`, so the previous Worker version and its assets remain live.

## Local use

Requires Node.js 22.

```bash
npm ci
npm test
npm run generate
npm run deploy
```

`ALLOW_SHRINK=1 npm run generate` explicitly accepts a real dataset contraction
that would otherwise be stopped by the publish gate.

## Free production architecture

1. A public GitHub repository stores the source.
2. Cloudflare Workers Builds installs from `package-lock.json`, runs
   `npm run build`, then `npm run deploy:production`.
3. The deployed Worker serves `dist/` as free static assets. Its 04:23 UTC Cron
   Trigger POSTs a secret deploy hook and marks the matching Healthchecks.io run
   as started. The hook response's build UUID links the start and completion.
4. The deploy command sends the success ping only after `wrangler deploy`
   finishes. A failed generation/build/deploy never sends success, so the free
   Healthchecks.io dead-man check alerts after its grace period.

This is one production runtime, one source repository, and one external dead-man
alarm. Static asset requests are free and unlimited; the single daily cron and
roughly 31 monthly builds are far inside the Workers Free allowances. No KV, R2,
Pages project, paid Worker, VPS, or GitHub Actions minutes are used.

## Bootstrap

1. Deploy the committed `dist/` snapshot once with `npm run deploy`.
2. Connect the Worker to the public GitHub repository in Workers Builds.
3. Use build command `npm run build`; set deploy command to
   `npm run deploy:production`.
4. Create a deploy hook for `main` and store it as Worker secret
   `DEPLOY_HOOK_URL`.
5. Create a free Healthchecks.io check (daily cron schedule, 30-minute grace). Store
   its ping URL twice: as runtime Worker secret `HEALTHCHECKS_PING_URL`, and as a
   Workers Builds secret with the same name. Runtime sends `/start`; the build
   sends success only after deployment.
6. Set the Workers Builds variable `BASELINE_URL` to the stable `workers.dev`
   origin and `BASELINE_FALLBACK_URL` to the Worker's custom-domain origin.
   Both hostnames serve the same deployment; the second path prevents a transient
   hostname failure from aborting the refresh. Workers Builds supplies
   `WORKERS_CI_BUILD_UUID` automatically.

Every build after bootstrap gates against the currently published data and
high-water marks. A configured remote baseline is fail-closed: if it cannot be
read, the build does not publish.

## Production endpoints

- `https://redesignmypage.com/getPublications.js` is the stable URL loaded by
  Webflow. `redesignmypage.com` is a Cloudflare Worker custom domain, so the
  Webflow embed does not need to change.
- `https://pragma-publications.pragma-publications.workers.dev/getPublications.js`
  is the provider-owned origin and remains enabled for diagnostics and build
  baselines.
- `/publications.json` contains the accepted dataset and `/status.json` contains
  its generation timestamp, counts, and high-water marks.

Both hostnames serve the same immutable deployment assets. A successful daily
build replaces them atomically; a failed build leaves the last good version live.

## Operations

The scheduled handler runs daily at `04:23 UTC`. It POSTs the private Workers
Builds deploy hook, then sends a correlated `/start` ping to Healthchecks.io.
`npm run deploy:production` sends the matching success ping only after the new
Worker version is live. Healthchecks.io uses the same cron expression with a
30-minute grace period, so a missing schedule, failed generation, rejected
retention gate, failed deployment, or missing success ping raises an alert.

Useful checks:

```bash
npm test
curl -fsS https://redesignmypage.com/status.json
curl -fsSI https://redesignmypage.com/getPublications.js
npx wrangler deployments status
```

Runtime secrets are `DEPLOY_HOOK_URL` and `HEALTHCHECKS_PING_URL`. Workers Builds
has the secret `HEALTHCHECKS_PING_URL` and the plaintext variables `BASELINE_URL`
and `BASELINE_FALLBACK_URL`. Never commit secret values. See `wrangler.jsonc` for
the schedule, static-assets binding, and custom domain; the Cloudflare dashboard
remains the source of truth for encrypted values and the deploy hook.

## Rollback

For a bad generated dataset or Worker release, roll back to the preceding Worker
deployment with `npx wrangler rollback`, then verify both production endpoints.
The publish gate and high-water marks should normally prevent this case.

The former VPS origin is no longer a rollback target. Do not detach the custom
domain or restore its old A record: `dblp-rpc.service` and
`/home/ubuntu/dblp-rpc` were removed on 2026-08-09. Recover by rolling back or
redeploying the Worker while leaving `redesignmypage.com` attached.

The old Let's Encrypt certificate and renewal configuration were deliberately
retained because a separate Redbelly workflow depends on them. They are not used
by the publications Worker and are not required for a Worker rollback. A Certbot
dry-run succeeded after cutover using the existing `dns-cloudflare` authenticator;
the credential file is owner-only (`0600`).
