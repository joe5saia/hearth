// Native Preview under a disposable parent: the website's parent would impose its blanket Access gate.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bindings, type WorkerConfig } from "cf/config";
import { z } from "zod";
import { workerRuntime } from "../cloudflare.config.ts";
import { Cloudflare, previewName, appInventorySchema, sourceAuthSchema } from "./preview.ts";
import { ampIdentity } from "./mcp-eval.ts";
import { initializePreviewSeed, previewSeedPending, seedPreview } from "./production-data.ts";

const directory = resolve(".wrangler/mcp-preview");
const statePath = resolve(directory, "state.json");
const stateSchema = z.object({
  name: z.string(), parent: z.string(), preview: z.string(), url: z.string(),
  db: z.string().optional(), kv: z.string().optional(), app: z.string().optional(),
  seedIntent: z.enum(["empty", "pending"]).optional(),
  aud: z.string().optional(), token: z.string().optional(), client_id: z.string().optional(), client_secret: z.string().optional(),
});
type State = z.infer<typeof stateSchema>;
const save = async (state: State) => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync("npx", ["cf", ...args], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env, CI: "true", CF_SEND_TELEMETRY: "false" } });

/** Deletes the disposable deployment before its Access, token, D1, and KV dependencies. */
export async function removeMcpPreview(api: Cloudflare, state: State) {
  if (state.parent !== `hearth-mcp-${state.name}`) throw new Error("Refusing a non-disposable parent Worker");
  const parentPath = `/workers/workers/${state.parent}`;
  const parentExists = async () => {
    try { await api.request(parentPath, z.unknown()); return true; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith(`GET ${parentPath}: HTTP 404;`)) return false;
      throw error;
    }
  };
  const removeListed = async (path: string, id: string | undefined, key: "id" | "uuid" = "id") => {
    if (!id) return;
    const schema = key === "uuid" ? z.object({ uuid: z.string() }).transform((item) => item.uuid) : z.object({ id: z.string() }).transform((item) => item.id);
    const exists = async () => (await api.list(path, schema)).includes(id);
    if (await exists()) await api.request(`${path}/${id}`, z.unknown(), "DELETE");
    if (await exists()) throw new Error(`Resource still exists at ${path}; retry cleanup after deletion propagates.`);
  };
  if (await parentExists()) await removeListed(`${parentPath}/previews`, state.preview);
  await removeListed("/access/apps", state.app);
  await removeListed("/access/service_tokens", state.token);
  await removeListed("/d1/database", state.db, "uuid");
  await removeListed("/storage/kv/namespaces", state.kv);
  if (await parentExists()) await api.request(parentPath, z.unknown(), "DELETE");
  if (await parentExists()) throw new Error("Parent Worker still exists; retry cleanup after deletion propagates.");
}

async function main() {
  const option = process.argv[3];
  if (option && !["--empty", "--reseed"].includes(option)) throw new Error("Use up [--empty|--reseed]. --empty preserves existing data.");
  const generatedName = `${previewName(process.env.AMP_THREAD_ID ?? "")}-mcp`;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Cloudflare credentials required");
  const api = new Cloudflare(account, token);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state: State | undefined;
  try { state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8"))); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (state && state.name.slice(8) !== generatedName.slice(8)) throw new Error("Preview belongs to a different thread. Preserve its state.");
  const name = state?.name ?? generatedName;
  if (process.argv[2] === "down") {
    if (!state) return;
    await removeMcpPreview(api, state);
    await rm(directory, { recursive: true });
    console.log("MCP preview removed"); return;
  }
  if (process.argv[2] !== "up") throw new Error("Usage: node tools/mcp-preview.ts up|down");
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  if (!branch.startsWith(`${process.env.AMP_THREAD_ID}-`)) throw new Error("Use the owning thread's working branch.");
  const identity = await ampIdentity("https://hearth-preview.invalid");
  if (identity.thread_id !== process.env.AMP_THREAD_ID) throw new Error("Preview owner must match the current orb identity.");
  // Fail before creating resources if this token cannot access OAuth storage.
  await api.list("/storage/kv/namespaces", z.object({ id: z.string() }));
  const parent = `hearth-mcp-${name}`;
  if (!state) {
    await api.request("/workers/workers", z.unknown(), "POST", { name: parent, subdomain: { enabled: false, previews_enabled: true }, tags: ["hearth:mcp-preview", `thread:${process.env.AMP_THREAD_ID}`] });
    state = { name, parent, preview: "", url: "" };
    await save(state);
  }
  if (!state.preview) {
    const preview = await api.request(`/workers/workers/${parent}/previews?ignore_base_config=true`, z.object({ id: z.string(), urls: z.array(z.string()) }), "POST", { name });
    state.preview = preview.id;
    state.url = preview.urls.find((url) => new URL(url).hostname.endsWith(".workers.dev")) ?? "";
    await save(state);
  }
  if (!state.url) throw new Error("Preview URL missing");
  const newDatabase = !state.db;
  if (!state.db) {
    state.db = (await api.request("/d1/database", z.object({ uuid: z.string() }), "POST", { name: `hearth-${name}` })).uuid;
    state.seedIntent = option === "--empty" ? "empty" : "pending";
    await save(state);
  }
  if (state.seedIntent) {
    if (state.seedIntent === "pending" && option === "--empty") throw new Error("Production seed initialization is pending; retry up or tear down first.");
    await initializePreviewSeed(api, state.db, state.seedIntent === "empty");
    delete state.seedIntent;
    await save(state);
  }
  if (!state.kv) { state.kv = (await api.request("/storage/kv/namespaces", z.object({ id: z.string() }), "POST", { title: `hearth-${name}` })).id; await save(state); }
  if (!state.token) {
    const token = await api.request("/access/service_tokens", z.object({ id: z.string(), client_id: z.string(), client_secret: z.string() }), "POST", { name: `hearth-${name}`, duration: "168h" });
    Object.assign(state, { token: token.id, client_id: token.client_id, client_secret: token.client_secret }); await save(state);
  }
  if (!state.app) {
    const apps = await api.list("/access/apps", appInventorySchema);
    const selected = apps.find((app) => app.name === "Hearth");
    if (!selected) throw new Error("Household Access policy missing");
    const source = sourceAuthSchema.parse(selected);
    const app = await api.request("/access/apps", z.object({ id: z.string(), aud: z.string() }), "POST", {
      name: `hearth-${name}`, type: "self_hosted", domain: `${new URL(state.url).hostname}/authorize`,
      allowed_idps: source.allowed_idps, auto_redirect_to_identity: true, app_launcher_visible: false,
      policies: [...source.policies.filter((p) => ["allow", "deny"].includes(p.decision)).map(({ name, decision, include, require, exclude }) => ({ name, decision, include, require, exclude })),
        { name: "Preview OAuth testing", decision: "non_identity", include: [{ service_token: { token_id: state.token } }] }],
    });
    state.app = app.id; state.aud = app.aud; await save(state);
  }
  if (!state.aud || !state.client_id || !state.db || !state.kv) {
    throw new Error("MCP Preview state is incomplete; inspect its resources before deploying or run down to clean up.");
  }
  const config: WorkerConfig = {
    name: parent, entrypoint: resolve("tools/mcp-preview-worker.ts"), compatibilityDate: workerRuntime.compatibilityDate,
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    env: {
      MCP_ORIGIN: bindings.text(state.url), ACCESS_AUD: bindings.text(state.aud), PREVIEW_CLIENT_ID: bindings.text(state.client_id),
      AMP_EVAL_PROJECT_ID: bindings.text(identity.project_id), AMP_EVAL_USER_ID: bindings.text(identity.user_id),
      AI: bindings.ai(), DB: bindings.d1({ id: state.db, name: `hearth-${name}` }), OAUTH_KV: bindings.kv({ id: state.kv }),
    },
  };
  const configPath = resolve(directory, "worker.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  run(["d1", "migrations", "apply", state.db, "--dir", resolve("migrations"), "--table", "d1_migrations"]);
  const pendingSeed = await previewSeedPending(api, state.db, option === "--empty" || option === "--reseed");
  if (pendingSeed && option === "--empty") throw new Error("Preview seed is incomplete; retry up or tear down before empty-fixture testing.");
  if (option === "--reseed" || pendingSeed || (newDatabase && option !== "--empty")) await seedPreview(api, state.db, `hearth-${name}`);
  // Keep REST precreation with ignore_base_config=true; cf does not expose that option.
  run(["previews", "deploy", name, "--mode", "cf-mcp-preview"], { HEARTH_PREVIEW_CONFIG: configPath });
  console.log(JSON.stringify({ url: state.url, mcp: `${state.url}/mcp`, eval: `${state.url}/eval/mcp`, name,
    note: "Isolated D1/KV. Eval orbs use npx task mcp:eval -- connect <eval URL>, then reload MCP. Clean up with npx task mcp:preview -- down." }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof z.ZodError || error instanceof SyntaxError ? "MCP Preview data failed validation; preserve the state file and inspect resources before cleanup." : error instanceof Error ? error.message : "MCP Preview failed; inspect saved state and resources before retrying.");
    process.exitCode = 1;
  });
}
