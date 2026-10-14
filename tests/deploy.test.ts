import type { PluginAPI, PluginThread, PluginToolContext, PluginToolDefinition } from "@ampcode/plugin";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import plugin from "../.amp/plugins/hearth-deploy.ts";
import { DeploymentState } from "../tools/deploy/state.ts";

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
    // SAFETY: PluginAPI requires the full host system, but initialization reads only
    // workspaceRoot. This real Git/disk smoke exercises initialization on every reload.
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
  // SAFETY: PluginThread requires host methods absent from this invocation fixture;
  // deployment tools read only id, exercised by every real Git/disk tool call below.
  const context: Pick<PluginToolContext, "thread"> = { thread: thread as PluginThread };
  // SAFETY: PluginToolContext requires unused host capabilities; deployment tools read
  // only thread.id. The real Git/disk calls below verify this bounded fixture.
  const ctx = context as PluginToolContext;

  const reload = async () => {
    tools.clear();
    // SAFETY: PluginAPI requires unused host capabilities; this plugin uses only the
    // three supplied members. Every reload below exercises registration and disk I/O.
    await plugin(api as PluginAPI);
  };

  const nextSchema = z.object({
    mode: z.enum(["dry-run", "production"]),
    next: z
      .object({
        attempt: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
        resume: z.boolean(),
      })
      .nullable(),
  });

  const next = async () => {
    const tool = tools.get("hearth_deploy_next");

    if (!tool) throw new Error("Deployment next tool was not registered");
    const result = z.string().parse(await tool.execute({}, ctx));

    return nextSchema.parse(JSON.parse(result));
  };

  const finish = (sha: string) => {
    const tool = tools.get("hearth_deploy_finish");

    if (!tool) throw new Error("Deployment finish tool was not registered");

    return tool.execute({ sha, outcome: "dry-run", evidence: "Git and disk smoke verified" }, ctx);
  };

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
    const state = new DeploymentState(privateDir).read();
    expect(state.attempts.map((attempt) => [attempt.sha, attempt.outcome])).toEqual([
      [main, "dry-run"],
      [newer, "dry-run"],
    ]);
    expect(statSync(join(privateDir, "state.json")).mode & 0o777).toBe(0o600);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
