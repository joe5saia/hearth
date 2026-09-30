import type { PluginAPI, PluginThread, PluginToolContext, PluginToolDefinition } from "@ampcode/plugin";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import plugin from "../.amp/plugins/hearth-deploy.ts";

it("claims real origin/main and persists interruption recovery and deduplication across reloads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hearth-deploy-smoke-"));
  const owner = "T-01a0e816-b3ae-712d-8730-ab501f548221";
  const privateDir = join(directory, ".amp/deploy-state");
  const tools = new Map<string, PluginToolDefinition>();

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const commit = (message: string) => {
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );

    return git("rev-parse", "HEAD");
  };

  const system: Pick<PluginAPI["system"], "workspaceRoot"> = {
    workspaceRoot: pathToFileURL(directory).href,
  };

  const api: Pick<PluginAPI, "system" | "registerTool" | "createWebhook"> = {
    // SAFETY: initialization reads only workspaceRoot from the system API.
    system: system as PluginAPI["system"],
    registerTool(tool) {
      tools.set(tool.name, tool);

      return { unsubscribe() {} };
    },
    async createWebhook() {
      return { url: "https://example.invalid/private-test-capability" };
    },
  };

  const thread: Pick<PluginThread, "id"> = { id: owner };
  // SAFETY: deployment tools read only id from the thread.
  const context: Pick<PluginToolContext, "thread"> = { thread: thread as PluginThread };
  // SAFETY: deployment tools read only thread.id from this invocation context.
  const ctx = context as PluginToolContext;

  const reload = async () => {
    tools.clear();
    // SAFETY: this plugin uses only the three supplied API members.
    await plugin(api as PluginAPI);
  };

  const next = async () => JSON.parse(String(await tools.get("hearth_deploy_next")!.execute({}, ctx)));

  const finish = (sha: string) =>
    tools
      .get("hearth_deploy_finish")!
      .execute({ sha, outcome: "dry-run", evidence: "Git and disk smoke verified" }, ctx);

  try {
    git("init", "-b", "main");
    const main = commit("main");
    git("remote", "add", "origin", directory);
    git("switch", "-c", "feature");
    const feature = commit("feature");
    expect(feature).not.toBe(main);
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, "owner.json"), JSON.stringify({ thread: owner, mode: "dry-run" }));
    vi.stubEnv("AMP_THREAD_ID", owner);
    await reload();
    expect(await next()).toMatchObject({ mode: "dry-run", next: { attempt: { sha: main }, resume: false } });

    git("switch", "main");
    const newer = commit("newer main");
    git("switch", "feature");
    await reload();
    expect(await next()).toMatchObject({ next: { attempt: { sha: main }, resume: true } });
    await finish(main);
    expect(await next()).toMatchObject({ next: { attempt: { sha: newer }, resume: false } });
    await finish(newer);
    await reload();
    expect((await next()).next).toBeNull();
    const state = JSON.parse(readFileSync(join(privateDir, "state.json"), "utf8"));
    expect(
      state.attempts.map((attempt: { sha: string; outcome: string }) => [attempt.sha, attempt.outcome]),
    ).toEqual([
      [main, "dry-run"],
      [newer, "dry-run"],
    ]);
    expect(statSync(join(privateDir, "state.json")).mode & 0o777).toBe(0o600);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
