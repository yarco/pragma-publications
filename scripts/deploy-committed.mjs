#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

const productionBranch = "main";
const generatedPaths = [
  "dist/getPublications.js",
  "dist/publications.json",
  "dist/status.json",
];

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGTERM",
  }).trim();
}

const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
const head = git("rev-parse", "HEAD");
const status = git(
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--",
  ".",
  ...generatedPaths.map((path) => `:(exclude)${path}`),
);
const remoteHead = git("ls-remote", "--exit-code", "origin", `refs/heads/${productionBranch}`).split(/\s+/)[0];

if (branch !== productionBranch) {
  throw new Error(`refusing deploy from ${branch}; production is ${productionBranch}`);
}
if (status) throw new Error(`refusing deploy with source or unexpected asset changes:\n${status}`);
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
  { stdio: "inherit", timeout: 5 * 60 * 1000, killSignal: "SIGTERM" },
);
if (result.error) throw new Error(`wrangler deploy failed: ${result.error.message}`);
if (result.status !== 0) throw new Error(`wrangler deploy failed with exit ${result.status}`);
console.log(`DEPLOYED pragma-publications from pushed commit ${head}`);
