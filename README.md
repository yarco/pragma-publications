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
5. Create a free Healthchecks.io check (one-day period, two-hour grace). Store
   its ping URL twice: as runtime Worker secret `HEALTHCHECKS_PING_URL`, and as a
   Workers Builds secret with the same name. Runtime sends `/start`; the build
   sends success only after deployment.
6. Set the Workers Builds variable `BASELINE_URL` to the stable `workers.dev`
   origin. Workers Builds supplies `WORKERS_CI_BUILD_UUID` automatically.

Every build after bootstrap gates against the currently published data and
high-water marks. A configured remote baseline is fail-closed: if it cannot be
read, the build does not publish.

The old VPS service remains the external rollback path during the proving period.
Do not retire it until the Worker endpoint has served correctly for several days.
