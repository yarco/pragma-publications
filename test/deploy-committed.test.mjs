import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(new URL("../scripts/deploy-committed.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeDeployRepo(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "pragma-deploy-repo-"));
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "pragma-deploy-remote-"));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "pragma-deploy-bin-"));
  t.after(() => Promise.all([
    fs.rm(repo, { recursive: true, force: true }),
    fs.rm(remote, { recursive: true, force: true }),
    fs.rm(bin, { recursive: true, force: true }),
  ]));

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Pragma test");
  git(repo, "config", "user.email", "pragma-test@example.invalid");
  await fs.mkdir(path.join(repo, "dist"));
  await Promise.all([
    fs.writeFile(path.join(repo, "source.mjs"), "export const value = 1;\n"),
    fs.writeFile(path.join(repo, "dist/getPublications.js"), "old js\n"),
    fs.writeFile(path.join(repo, "dist/publications.json"), "{}\n"),
    fs.writeFile(path.join(repo, "dist/status.json"), "{}\n"),
  ]);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  git(remote, "init", "--bare");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  const wrangler = path.join(bin, "wrangler");
  await fs.writeFile(wrangler, "#!/bin/sh\nexit 0\n");
  await fs.chmod(wrangler, 0o755);
  return { repo, bin };
}

function runDeploy(repo, bin) {
  return spawnSync(process.execPath, [deployScript], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

test("deploy permits the three generated artifacts to differ from Git", async (t) => {
  const { repo, bin } = await makeDeployRepo(t);
  await fs.writeFile(path.join(repo, "dist/getPublications.js"), "fresh js\n");
  await fs.writeFile(path.join(repo, "dist/status.json"), '{"fresh":true}\n');

  const result = runDeploy(repo, bin);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DEPLOYED pragma-publications from pushed commit/);
});

test("deploy still rejects source changes", async (t) => {
  const { repo, bin } = await makeDeployRepo(t);
  await fs.writeFile(path.join(repo, "source.mjs"), "export const value = 2;\n");

  const result = runDeploy(repo, bin);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing deploy with source or unexpected asset changes/);
  assert.match(result.stderr, /source\.mjs/);
});

test("deploy rejects unexpected files in dist", async (t) => {
  const { repo, bin } = await makeDeployRepo(t);
  await fs.writeFile(path.join(repo, "dist/unexpected.txt"), "do not deploy me\n");

  const result = runDeploy(repo, bin);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist\/unexpected\.txt/);
});
