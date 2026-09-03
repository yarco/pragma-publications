# Pragma publications

Generates the publications data used by <https://www.pragma.ooo/research> and
publishes it as a static JavaScript file. The production design needs no VPS:
one Cloudflare Worker serves the static files, runs the daily schedule, and
triggers a Git-connected Workers Build of its next version.

Cross-project production policy lives in the sibling
[`cloudflare-fleet`](../cloudflare-fleet/README.md) repository. The vault's
`AI/Coding/Cloudflare.md` owns fleet topology and decisions; this README owns
Pragma-specific builds, data gates, recovery, and rollback. Workers Builds is
the production deploy path; the fleet auditor independently proves its checked-
out Git source, live Worker bundle, Cron, observability, and Healthchecks state.

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
npm run deploy
```

The manual deploy command runs the complete test and generation build before
the committed-source deployment helper; there is no supported stale-`dist`
shortcut. Workers Builds already invokes `npm run build` before its separate
`npm run deploy:production` command, so it does not build twice.

Every build, local or in Workers Builds, gates against the same thing: the data
currently published on the live deployment. `BASELINE_URL` and
`BASELINE_FALLBACK_URL` override the baseline hostnames; unset — a local run —
they default to the same two production origins. The baseline is fail-closed:
if it cannot be read, nothing is published.

`ALLOW_SHRINK=1 npm run generate` explicitly accepts a real dataset contraction
that would otherwise be stopped by the publish gate. It also skips the baseline
fetch entirely — the candidate publishes on its own authority and the
high-water marks restart from its values. That is the bootstrap path for a
first deployment, when nothing is published yet.

## Free production architecture

1. A public GitHub repository stores the source.
2. Cloudflare Workers Builds installs from `package-lock.json`, runs
   `npm run build`, then `npm run deploy:production`.
3. The deployed Worker serves `dist/` as free static assets. Its three daily Cron
   Triggers POST a secret deploy hook, ping the heartbeat check, and write a
   status-neutral breadcrumb to the freshness check. The hook response's build
   UUID correlates every event for that run.
4. The deploy command sends the freshness success ping only after `wrangler
   deploy` finishes. A failed generation/build/deploy never sends success, so the
   freshness check alerts once three consecutive attempts have missed.
5. The committed deploy helper refuses any working-tree change, an off-`main`
   checkout, or an unpushed commit. The three generated `dist/` outputs are
   gitignored, so a fresh build never dirties the tree, while anything else
   appearing under `dist/` is an untracked file and blocks the deploy. The
   helper also enables Wrangler strict mode and stamps the exact Git SHA into
   Cloudflare's immutable version metadata.

This is one production runtime, one source repository, and two external dead-man
alarms. Static asset requests are free and unlimited; the three daily crons and
roughly 91 monthly builds — about 61 of the 3,000 free monthly build minutes — are
far inside the Workers Free allowances. No KV, R2, Pages project, paid Worker,
VPS, or GitHub Actions minutes are used.

## Bootstrap

1. Generate, test, and deploy the initial snapshot with
   `ALLOW_SHRINK=1 npm run deploy`. The flag publishes without consulting a
   baseline, which is exactly what a first deployment needs: nothing is
   published yet to compare against.
2. Connect the Worker to the public GitHub repository in Workers Builds.
3. Use build command `npm run build`; set deploy command to
   `npm run deploy:production`.
4. Create a deploy hook for `main` and store it as Worker secret
   `DEPLOY_HOOK_URL`.
5. Create two free Healthchecks.io checks, both on `23 4,12,20 * * *` UTC. The
   freshness check takes an 18-hour grace; store its ping URL as runtime Worker
   secret `HEALTHCHECKS_PING_URL` *and* as a Workers Builds secret of the same
   name, because the build sends both the success ping and failure `/log` events.
   The heartbeat check takes a 30-minute grace; store its ping URL as runtime
   secret `HEARTBEAT_PING_URL` only. See Operations for why the freshness check
   must never receive `/start`.
6. Set the Workers Builds variable `BASELINE_URL` to the stable `workers.dev`
   origin and `BASELINE_FALLBACK_URL` to the Worker's custom-domain origin.
   Both hostnames serve the same deployment; the second path prevents a transient
   hostname failure from aborting the refresh. Workers Builds supplies
   `WORKERS_CI_BUILD_UUID` automatically.
7. Store separate runtime secrets `RECOVERY_TOKEN` and
   `CLOUDFLARE_SCHEDULE_TOKEN`. The latter needs only permission to update this
   Worker's Cron Trigger. Create a dedicated Healthchecks webhook named
   `pragma-publications-scheduler-recovery`: on DOWN only, POST to
   `https://pragma-publications.pragma-publications.workers.dev/recover` with
   `Authorization: Bearer <RECOVERY_TOKEN>` and a browser `User-Agent`. Assign
   it only to the scheduler heartbeat check. Do not configure an UP request,
   attach it to the freshness check, or reuse another project's recovery hook.

Every build after bootstrap gates against the currently published data and
high-water marks on the live deployment. The remote baseline is fail-closed:
if it cannot be read, the build does not publish.

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

### Schedule and alert policy

The scheduled handler runs three times a day at `04:23`, `12:23` and `20:23` UTC.
DBLP fails transiently, in any slot, in more than one shape: bare `TypeError:
fetch failed`, `SocketError: other side closed`, `503`, `504`. A later attempt
with unchanged code succeeds. One attempt a day turned that into an alert; three
attempts eight hours apart ride it out. A single failed slot needs no
investigation — the next slot clears it.

Tolerated failures are silent by design, so the `/log` body is the only record:
`GET /api/v3/checks/<uuid>/pings/<n>/body`. A bodiless ping answers `404` with an
HTML page — that is the API saying "no body", not a fault. The Worker's own
breadcrumb is a GET and always reads that way; only `scripts/notify-failure.mjs`
attaches a body.

The policy is: **tolerate two consecutive failed attempts, alert on the third,
any success resets.** Publications are not time critical, so roughly a day of
staleness is preferable to an email every time DBLP hiccups.

Two Healthchecks.io checks implement this, with deliberately different jobs.

| | Freshness check | Heartbeat check |
|---|---|---|
| Secret | `HEALTHCHECKS_PING_URL` | `HEARTBEAT_PING_URL` |
| Question | has a refresh succeeded recently? | did cron fire and did the build get queued? |
| Schedule | `23 4,12,20 * * *` UTC | `23 4,12,20 * * *` UTC |
| Grace | **18 h** | 30 min |
| Success ping | only after `wrangler deploy` completes | immediately after the deploy hook returns a build UUID |
| Failure ping | `/log` only — never status changing | `/fail` when the hook is unreachable |

### Scheduler recovery

`POST /recover` is a concealed DOWN-only recovery hook for the heartbeat check.
It accepts a separate constant-time bearer token, restores exactly the configured
`23 4,12,20 * * *` trigger through Cloudflare's schedules API, and queues one
catch-up Workers Build through the existing deploy hook. A recently modified
correct trigger is left untouched for 15 minutes so webhook retries cannot keep
restarting Cloudflare's propagation window. The deploy hook has a 30-second
timeout, and any recovery failure returns non-2xx so Healthchecks can retry.

This webhook must not be enabled on the freshness check. A freshness DOWN means
three publication builds failed; another automatic build may only hammer the same
DBLP or scraper fault. The heartbeat check is the one that diagnoses a missing
Cron delivery and can therefore be repaired by re-arming the trigger.

**Why 18 hours.** Slots are eight hours apart, so the third consecutive failure
lands 16 h after the first missed slot. Grace must exceed 16 h to reach the third
failure and stay under 24 h so a fourth attempt cannot slip by unreported. 18 h
sits in that window with two hours of margin, which covers the 20-minute build cap
plus queueing on the free plan's single concurrent build.

**Even spacing is load bearing.** The grace figure is derived from the interval
(`2 x 8h + margin`). Staggering the slots to uneven times would silently change how
many failures are tolerated. Change all three crons together or recompute the grace.

**The freshness check must use a cron schedule, not a simple period.** Healthchecks
computes the deadline as *(next scheduled time after the last ping) + grace*.
Configuring an "every 8 hours" period check with the same grace yields a two-strike
system instead of three.

**Known limitation: an off-schedule success next to a slot can buy an extra strike.**
If a success ping lands just *after* a slot time while that slot's own build is still
in flight — realistically only when a manual re-run finishes in the minute after a
cron fires — Healthchecks anchors the deadline on the *following* slot. Up to four
attempts can then fail before the email, roughly 34 h after the last success instead
of 26 h. Push-triggered Builds are the other source of off-grid success pings: every
push to `main` builds and deploys, and only deploy-hook runs can heartbeat, so a
push-deployed success moves the freshness deadline without proving anything about
cron delivery — the heartbeat check alone answers that question.

This is accepted, not overlooked. It is bounded (the alert is late, never absent),
and no single grace value fixes both cases: tolerating three failures normally
requires grace > 16 h, while capping the race at three would require grace < 16 h.
Closing it properly needs a stored attempt counter, whose own failure modes are worse
— the counter must be incremented by the build container that just failed, and
tolerated failures would need a keep-alive ping that asserts health while the system
is failing, so any bug in it produces permanent silence instead of a late email.

### Never send `/start` to the freshness check

Measured against the live Healthchecks API on 2026-08-14: with a 60-second grace, a
`/start` at `T0` and a second `/start` at `T0+50s` produced a down flip at
`T1+60s`, not `T0+60s`. A start ping moves the alert deadline. With three attempts
a day against an 18-hour grace, a `/start` on each failing run would defer the
alert indefinitely and the page would serve a frozen snapshot with nobody notified.

`/log` was measured the same day to leave the deadline untouched — success at
`08:10:01` with a 60 s timeout and 60 s grace, `/log` at `08:10:47`, down flip at
exactly `08:12:01` — so it is safe as a forensic channel.

Note that the Management API reports `last_start: null` and leaves `last_ping` at
the last status-changing ping even when start pings exist. Only the pings list and
flip history are trustworthy.

### Failure reporting

Because two failures now pass silently, the log trail is the only record of them.
`scripts/notify-failure.mjs` runs from the `||` branch of both `npm run build` and
`npm run deploy:production` and POSTs a `/log` event carrying the stage, build UUID,
reason, and full `error.cause` chain.

The cause chain matters: on 2026-08-14 the build log said only
`[generate] failed: fetch failed`, which cannot distinguish a DNS failure from a
connection reset. `lib/failure-report.mjs` now unwraps the chain to the real errno.

A publish-gate rejection is deterministic and will not repair itself on retry, yet
it shares the three-strike tolerance with transient faults. That is intentional —
the site stays correct either way — but it means the `/log` reason is what
distinguishes "DBLP blipped" from "the scraper is broken" at triage time. If a
stuck scraper should page sooner, give gate rejections their own check rather than
shortening the freshness grace.

One failure class produces no `/log` body at all: a build killed at Cloudflare's
platform layer before any repository command runs. Observed 2026-09-03 12:23 UTC
as `Build initialization failed: unable to verify Worker`, outcome `terminated`
after five minutes. Both `||` reporting branches live inside the build container,
so such a slot leaves only a bodiless freshness `/log` next to its heartbeat
success and no new deployment. That shape — heartbeat UP, bodiless `/log`, no
deployment — means read the Workers Builds record: the build UUID is the pings'
`rid`, and `GET /accounts/<account>/builds/builds/<rid>` (plus its `/logs`
endpoint) carries the platform's own failure line. The build list is the third
evidence source, after the two ping streams.

Useful checks:

```bash
npm test
curl -fsS https://redesignmypage.com/status.json
curl -fsSI https://redesignmypage.com/getPublications.js
npx wrangler deployments status
```

Runtime secrets are `DEPLOY_HOOK_URL`, `HEALTHCHECKS_PING_URL`,
`HEARTBEAT_PING_URL`, `RECOVERY_TOKEN`, and `CLOUDFLARE_SCHEDULE_TOKEN`.
Workers Builds has the secret `HEALTHCHECKS_PING_URL` and the plaintext variables `BASELINE_URL`
and `BASELINE_FALLBACK_URL`. Never commit secret values. See `wrangler.jsonc` for
the schedule, static-assets binding, and custom domain; the Cloudflare dashboard
remains the source of truth for encrypted values and the deploy hook.

### Unknown paths must return 404, not throw

Static Assets serves `dist/`; everything else falls through to the `fetch`
handler. Without one, each of those requests is an uncaught exception —
scanner traffic alone produced ~1,100 a day against ~12 real requests. The
handler answers `404`, so `scriptThrewException` is a real signal here and any
non-zero count is worth reading:

```bash
CF=$(security find-generic-password -s cloudflare -a 'yarcoh@gmail.com:operator-api-token' -w)
curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CF" \
  -H "Content-Type: application/json" -d '{"query":"query{viewer{accounts(filter:{accountTag:\"b43256ec662caecc5ffa2e8315b465ef\"}){workersInvocationsAdaptive(limit:100, filter:{datetime_geq:\"<iso8601>\", datetime_lt:\"<iso8601>\", scriptName:\"pragma-publications\"}){dimensions{status}sum{requests errors}}}}}"}'
```

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
