import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

// Publishing is an explicit task, never a side effect of building or testing.
const repository = "joe5saia/hearth";
const directory = ".amp/plugin-dist";
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();
const release = JSON.parse(await readFile(`${directory}/release.json`, "utf8"));
assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(release.dirty, false, "Refuse to release an archive built from uncommitted work");
assert.equal(run("git", ["status", "--porcelain"]), "", "Release requires a clean worktree");
assert.equal(release.commit, run("git", ["rev-parse", "HEAD"]), "Build is stale");
assert.deepEqual(release.assets, ["hearth-plugin.zip", "hearth-chatgpt.zip"]);
assert.ok(release.appId, "Web app registration is required");
const sums = await readFile(`${directory}/SHA256SUMS`, "utf8");
for (const line of sums.trim().split("\n")) {
  const [hash, name] = line.split("  ");
  assert.ok(release.assets.includes(name), "Unexpected checksum filename");
  const bytes = await readFile(join(directory, name));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, `Checksum mismatch: ${name}`);
  const files = unzipSync(bytes);
  const build = JSON.parse(strFromU8(files["BUILD.json"]));
  assert.equal(build.commit, release.commit);
  assert.equal(build.version, release.version);
}
assert.equal(sums.trim().split("\n").length, release.assets.length);
const tag = `plugin-v${release.version}`;
const gh = (...args: string[]) => run("gh", [...args, "--repo", repository]);
const currentMain = run("gh", ["api", `repos/${repository}/commits/main`, "--jq", ".sha"]);
if (currentMain !== release.commit) {
  console.log("Skipping superseded revision; the current main deployment will publish the latest plugin.");
  process.exit(0);
}
const existing = spawnSync("gh", ["release", "view", tag, "--repo", repository, "--json", "isDraft,targetCommitish"], { encoding: "utf8" });
if (existing.status === 0) {
  const previous = JSON.parse(existing.stdout);
  const target = previous.isDraft ? previous.targetCommitish : run("gh", ["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]);
  assert.equal(target, release.commit, "Release points to a different commit");
}
if (existing.status !== 0) {
  // Do not interpret authentication/network failures as an absent release.
  assert.match(existing.stderr, /release not found/i, existing.stderr);
  gh("release", "create", tag, "--target", release.commit, "--draft", "--title", `Hearth plugin ${release.version}`,
    "--notes", `Source: https://github.com/${repository}/commit/${release.commit}\n\nDownload **hearth-chatgpt.zip** for ChatGPT web. **hearth-plugin.zip** is the portable MCP package (desktop / submission draft). Both include the recipe, meal-planning, and shopping skills.\n\nInstall: Admin → Plugins → Add → Upload plugin. Update an existing manual install with Upload new version. Requires upload permission and access to the registered Hearth app. Complete household OAuth; a ZIP grants no household access.\n\nInstructions: https://github.com/${repository}/blob/${release.commit}/plugins/hearth/README.md\n\nGitHub releases do not automatically update ChatGPT. Checksums are in SHA256SUMS.`);
} else if (!JSON.parse(existing.stdout).isDraft) {
  const temporary = await mkdtemp(join(tmpdir(), "hearth-release-"));
  try {
    // A retry may follow a successful publish whose response was lost. Never mutate it.
    gh("release", "download", tag, "--dir", temporary, "--pattern", "SHA256SUMS", "--pattern", "hearth-*.zip");
    assert.equal(await readFile(join(temporary, "SHA256SUMS"), "utf8"), sums, "Published version differs; use a new version");
    for (const name of release.assets) assert.deepEqual(await readFile(join(temporary, name)), await readFile(join(directory, name)));
    console.log(`Already published and verified: https://github.com/${repository}/releases/tag/${tag}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.exit(0);
}

// Upload all assets to the draft before making it latest: readers never see a partial release.
gh("release", "upload", tag, ...release.assets.map((name: string) => join(directory, name)), `${directory}/SHA256SUMS`, "--clobber");
gh("release", "edit", tag, "--draft=false", "--latest");
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
