import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";

it("builds real, reproducible web and portable ZIPs with distinct connection wiring and no checkout leakage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-plugin-smoke-"));

  const build = (...args: string[]) =>
    execFileSync("npx", ["task", "plugin:build", "--", "--output", directory, ...args], {
      encoding: "utf8",
      env: { ...process.env, CHATGPT_APP_ID: "" },
    });

  try {
    build("--version", "2.3.7", "--app-id", "plugin_asdk_app_smoke", "--require-web");
    const web = await readFile(join(directory, "hearth-chatgpt.zip"));
    const portable = await readFile(join(directory, "hearth-plugin.zip"));
    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    expect(sums).toBe(
      `${createHash("sha256").update(portable).digest("hex")}  hearth-plugin.zip\n` +
        `${createHash("sha256").update(web).digest("hex")}  hearth-chatgpt.zip\n`,
    );

    // Independent ZIP reader checks CRCs and hidden root files, not just our writer's inverse.
    expect(
      execFileSync("unzip", ["-t", join(directory, "hearth-chatgpt.zip")], { encoding: "utf8" }),
    ).toContain("No errors detected");
    expect(
      execFileSync("unzip", ["-t", join(directory, "hearth-plugin.zip")], { encoding: "utf8" }),
    ).toContain("No errors detected");

    const skills = ["managing-recipes", "planning-meals", "preparing-shopping"];

    const common = [
      "BUILD.json",
      "EVALUATION.md",
      "README.md",
      "assets/icon-dark.png",
      "assets/icon.png",
      "plugin.json",
      ...skills.map((name) => `skills/${name}/SKILL.md`),
    ];

    const webFiles = unzipSync(web);
    const portableFiles = unzipSync(portable);
    expect(Object.keys(webFiles).sort()).toEqual([...common, ".app.json"].sort());
    expect(Object.keys(portableFiles).sort()).toEqual(
      [...common, "mcp.json", ...skills.map((name) => `skills/${name}/agents/openai.yaml`)].sort(),
    );
    const manifest = JSON.parse(strFromU8(webFiles["plugin.json"]));
    expect(manifest).toMatchObject({
      name: "hearth",
      version: "2.3.7",
      extensions: { "com.openai": { apps: "./.app.json" } },
    });
    expect(JSON.parse(strFromU8(webFiles[".app.json"]))).toEqual({
      apps: { hearth: { id: "asdk_app_smoke", required: true } },
    });
    expect(JSON.parse(strFromU8(portableFiles["plugin.json"])).extensions["com.openai"].apps).toBeUndefined();
    expect(JSON.parse(strFromU8(portableFiles["mcp.json"]))).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { hearth: { type: "streamable-http", url: "https://hearth-mcp.joesaia.trade/mcp" } },
    });
    expect(JSON.parse(strFromU8(webFiles["BUILD.json"]))).toMatchObject({
      version: "2.3.7",
      target: "chatgpt-web",
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });

    for (const name of skills) {
      const path = `skills/${name}/SKILL.md`;
      expect(strFromU8(webFiles[path])).toBe(await readFile(`plugins/hearth/${path}`, "utf8"));
      expect(webFiles[path]).toEqual(portableFiles[path]);
    }

    for (const field of ["composerIcon", "composerIconDark", "logo", "logoDark"]) {
      const path = manifest.extensions["com.openai"].interface[field].slice(2);
      const png = Buffer.from(webFiles[path]);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(1024);
      expect(png.readUInt32BE(20)).toBe(1024);
    }

    // The underlying app ID and the plugin URL's prefixed ID must produce identical archives.
    build("--version", "2.3.7", "--app-id", "asdk_app_smoke", "--require-web");
    expect(await readFile(join(directory, "hearth-chatgpt.zip"))).toEqual(web);
    expect(await readFile(join(directory, "hearth-plugin.zip"))).toEqual(portable);
    build();
    expect(await readdir(directory)).not.toContain("hearth-chatgpt.zip");
    expect(JSON.parse(await readFile(join(directory, "release.json"), "utf8")).assets).toEqual([
      "hearth-plugin.zip",
    ]);

    for (const args of [["--require-web"], ["--app-id", "plugin_not-an-app"], ["--version", "1.02.3"]]) {
      const result = spawnSync("npx", ["task", "plugin:build", "--", "--output", directory, ...args], {
        encoding: "utf8",
        env: { ...process.env, CHATGPT_APP_ID: "" },
      });

      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(await readdir(directory)).not.toContain("hearth-chatgpt.zip");
    }

    const environment = { ...process.env };
    delete environment.CHATGPT_APP_ID;
    execFileSync("npx", ["task", "plugin:build", "--", "--output", directory, "--require-web"], {
      encoding: "utf8",
      env: environment,
    });
    const configured = unzipSync(await readFile(join(directory, "hearth-chatgpt.zip")));
    expect(JSON.parse(strFromU8(configured[".app.json"]))).toEqual({
      apps: { hearth: { id: "asdk_app_6abc4d71239c8191b3718add10501aff", required: true } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
