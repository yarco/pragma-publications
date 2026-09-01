#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

const productionBranch = "main";

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
const head = git("rev-parse", "HEAD");
const status = git("status", "--porcelain", "--untracked-files=all");
const remoteHead = git("ls-remote", "--exit-code", "origin", `refs/heads/${productionBranch}`).split(/\s+/)[0];

if (branch !== productionBranch) {
  throw new Error(`refusing deploy from ${branch}; production is ${productionBranch}`);
}
if (status) throw new Error(`refusing deploy from a dirty working tree:\n${status}`);
if (head !== remoteHead) {
  throw new Error(`refusing unpushed or stale source: HEAD ${head} != origin/${productionBranch} ${remoteHead}`);
}

const origin = git("remote", "get-url", "origin").replace(/\.git$/, "");
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
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error(`wrangler deploy failed with exit ${result.status}`);
console.log(`DEPLOYED pragma-publications from pushed commit ${head}`);
