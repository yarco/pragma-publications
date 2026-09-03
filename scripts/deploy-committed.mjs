#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { writeFailureReport, buildFailureReport } from "../lib/failure-report.mjs";
import { FAILURE_STAGES } from "../lib/config.mjs";

const productionBranch = "main";

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGTERM",
  }).trim();
}

async function main() {
  const isCI = !!process.env.WORKERS_CI;

  const branch = isCI ? process.env.WORKERS_CI_BRANCH : git("symbolic-ref", "--quiet", "--short", "HEAD");
  if (!branch) {
    throw new Error("Could not determine branch (WORKERS_CI_BRANCH is empty or symbolic-ref failed)");
  }

  const head = isCI ? process.env.WORKERS_CI_COMMIT_SHA : git("rev-parse", "HEAD");
  if (!head) {
    throw new Error("Could not determine HEAD (WORKERS_CI_COMMIT_SHA is empty or rev-parse failed)");
  }

  const status = git("status", "--porcelain", "--untracked-files=all");

  let remoteHead = head;
  if (!isCI) {
    remoteHead = git("ls-remote", "--exit-code", "origin", `refs/heads/${productionBranch}`).split(/\s+/)[0];
  }

  if (branch !== productionBranch) {
    throw new Error(`refusing deploy from ${branch}; production is ${productionBranch}`);
  }
  if (status) throw new Error(`refusing deploy with source or unexpected asset changes:\n${status}`);
  if (head !== remoteHead) {
    throw new Error(`refusing unpushed or stale source: HEAD ${head} != origin/${productionBranch} ${remoteHead}`);
  }

  let origin;
  try {
    origin = git("remote", "get-url", "origin").replace(/\.git$/, "");
  } catch {
    origin = "unknown-origin";
  }

  const result = spawnSync(
    "wrangler",
    [
      "deploy",
      "--strict",
      "--tag",
      `git-${head}`,
      "--message",
      `${origin}@${head} (${branch}, Workers Builds)`,
    ],
    { stdio: "inherit", timeout: 5 * 60 * 1000, killSignal: "SIGTERM" },
  );
  
  if (result.error) throw new Error(`wrangler deploy failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`wrangler deploy failed with exit ${result.status}`);
  console.log(`DEPLOYED pragma-publications from pushed commit ${head}`);
}

main().catch(async (error) => {
  console.error(`[deploy] failed: ${error.stack || error.message}`);
  await writeFailureReport(buildFailureReport({
    stage: FAILURE_STAGES.DEPLOY,
    reason: 'deploy-committed threw',
    error
  }));
  process.exitCode = 1;
});
