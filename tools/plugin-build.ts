import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { strToU8, zipSync } from "fflate";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".amp/plugin-dist" },
    version: { type: "string" },
    "app-id": { type: "string" },
    "require-web": { type: "boolean", default: false },
  },
});

const root = "plugins/hearth";
const manifest = JSON.parse(await readFile(`${root}/plugin.json`, "utf8"));
const mcp = JSON.parse(await readFile(`${root}/mcp.json`, "utf8"));
const apps = JSON.parse(await readFile(`${root}/.app.json`, "utf8"));
const version = values.version ?? manifest.version;
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use a numeric semantic version");
const appId = (values["app-id"] ?? process.env.CHATGPT_APP_ID ?? apps.apps.hearth.id).trim().replace(/^plugin_/, "");
if (appId) assert.match(appId, /^asdk_app_[a-zA-Z0-9_-]+$/, "Use Hearth's registered asdk_app_ ID, not a plugin ID or URL");
assert.ok(!values["require-web"] || appId, "A registered Hearth app ID is required to release a ChatGPT web archive.");

assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
assert.equal(manifest.name, "hearth");
assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
assert.deepEqual(mcp.mcpServers, {
  hearth: { type: "streamable-http", url: "https://hearth-mcp.joesaia.trade/mcp" },
});
manifest.version = version;
const presentation = manifest.extensions["com.openai"].interface;
assert.ok(presentation.displayName.length <= 30 && presentation.shortDescription.length <= 30);
assert.ok(presentation.defaultPrompt.length <= 3);
assert.ok(presentation.defaultPrompt.every((prompt: string) => prompt.length <= 128));

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
const json = (value: object) => strToU8(JSON.stringify(value, null, 2) + "\n");
// Explicit allowlist: never recursively zip the checkout, credentials, or household data.
const files: Record<string, Uint8Array> = {};
for (const name of ["README.md", "EVALUATION.md"]) files[name] = await readFile(join(root, name));
const skills = ["managing-recipes", "planning-meals", "preparing-shopping"];
for (const name of skills) {
  const path = `skills/${name}/SKILL.md`;
  const text = await readFile(join(root, path), "utf8");
  assert.ok(text.startsWith(`---\nname: ${name}\ndescription: `), `Invalid skill frontmatter: ${path}`);
  assert.ok(text.includes("\n---\n"), `Missing frontmatter end: ${path}`);
  files[path] = strToU8(text);
}
files["assets/icon.png"] = await readFile("public/brand/icon.png");
files["assets/icon-dark.png"] = await readFile("public/brand/icon-reversed.png");
for (const key of ["composerIcon", "composerIconDark", "logo", "logoDark"]) {
  assert.ok(files[presentation[key].replace(/^\.\//, "")], `Missing ${key}`);
}

// Fixed ZIP timestamps and sorted entries make identical inputs byte-for-byte reproducible.
const archive = (entries: Record<string, Uint8Array>) => zipSync(
  Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  { level: 9, mtime: new Date("2000-01-01T00:00:00Z") },
);
const artifacts = new Map<string, Uint8Array>();
const portable = { ...files, "plugin.json": json(manifest), "mcp.json": json(mcp),
  "BUILD.json": json({ version, commit, dirty, target: "portable" }) };
for (const skill of skills) {
  portable[`skills/${skill}/agents/openai.yaml`] = strToU8(
    'dependencies:\n  tools:\n    - type: "mcp"\n      value: "hearth"\n      description: "Access the shared Hearth household"\n      transport: "streamable_http"\n      url: "https://hearth-mcp.joesaia.trade/mcp"\n',
  );
}
artifacts.set("hearth-plugin.zip", archive(portable));
if (appId) {
  manifest.extensions["com.openai"].apps = "./.app.json";
  artifacts.set("hearth-chatgpt.zip", archive({
    ...files,
    "plugin.json": json(manifest),
    ".app.json": json({ apps: { hearth: { id: appId, required: true } } }),
    "BUILD.json": json({ version, commit, dirty, target: "chatgpt-web" }),
  }));
}

await mkdir(values.output, { recursive: true });
// Remove only our known outputs, including a stale web ZIP from an earlier configured build.
for (const name of ["hearth-plugin.zip", "hearth-chatgpt.zip", "SHA256SUMS", "release.json"])
  await rm(join(values.output, name), { force: true });
const sums: string[] = [];
for (const [name, bytes] of artifacts) {
  await writeFile(join(values.output, name), bytes);
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
}
await writeFile(join(values.output, "SHA256SUMS"), sums.join("\n") + "\n");
await writeFile(join(values.output, "release.json"), json({ version, commit, dirty, appId: appId || null, assets: [...artifacts.keys()] }));
console.log(`Built Hearth ${version}: ${[...artifacts.keys()].join(", ")} in ${values.output}`);
if (!appId) console.log("Web archive not built: register Hearth and supply CHATGPT_APP_ID (see plugins/hearth/README.md).");
