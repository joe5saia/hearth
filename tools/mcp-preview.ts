// Native Preview under a disposable parent: the website's parent would impose its blanket Access gate.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cloudflare, previewName } from "./preview.ts";
import { ampIdentity } from "./mcp-eval.ts";

const directory = resolve(".wrangler/mcp-preview");
const statePath = resolve(directory, "state.json");
type State = { name: string; parent: string; preview: string; url: string; db?: string; kv?: string; app?: string; aud?: string; token?: string; client_id?: string; client_secret?: string };
const api = new Cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID!, process.env.CLOUDFLARE_API_TOKEN!);
const save = async (state: State) => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
const run = (args: string[]) => execFileSync("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });

export async function removeMcpPreview(api: Cloudflare, state: State) {
  if (state.parent !== `hearth-mcp-${state.name}`) throw new Error("Refusing a non-disposable parent Worker");
  const parentPath = `/workers/workers/${state.parent}`;
  const parentExists = async () => {
    try { await api.request(parentPath); return true; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith(`GET ${parentPath}: HTTP 404;`)) return false;
      throw error;
    }
  };
  const removeListed = async (path: string, id: string | undefined, key = "id") => {
    if (!id) return;
    const exists = async () => (await api.list<Record<string, string>>(path)).some((item) => item[key] === id);
    if (await exists()) await api.request(`${path}/${id}`, "DELETE");
    if (await exists()) throw new Error(`Resource still exists at ${path}; retry cleanup after deletion propagates.`);
  };
  if (await parentExists()) await removeListed(`${parentPath}/previews`, state.preview);
  await removeListed("/access/apps", state.app);
  await removeListed("/access/service_tokens", state.token);
  await removeListed("/d1/database", state.db, "uuid");
  await removeListed("/storage/kv/namespaces", state.kv);
  if (await parentExists()) await api.request(parentPath, "DELETE");
  if (await parentExists()) throw new Error("Parent Worker still exists; retry cleanup after deletion propagates.");
}

async function main() {
  const generatedName = `${previewName(process.env.AMP_THREAD_ID ?? "")}-mcp`;
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) throw new Error("Cloudflare credentials required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state: State | undefined;
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
  await api.list("/storage/kv/namespaces");
  const parent = `hearth-mcp-${name}`;
  if (!state) {
    await api.request("/workers/workers", "POST", { name: parent, subdomain: { enabled: false, previews_enabled: true }, tags: ["hearth:mcp-preview", `thread:${process.env.AMP_THREAD_ID}`] });
    state = { name, parent, preview: "", url: "" };
    await save(state);
  }
  if (!state.preview) {
    const preview = await api.request<{ id: string; urls: string[] }>(`/workers/workers/${parent}/previews?ignore_base_config=true`, "POST", { name });
    state.preview = preview.id;
    state.url = preview.urls.find((url) => new URL(url).hostname.endsWith(".workers.dev"))!;
    await save(state);
  }
  if (!state.url) throw new Error("Preview URL missing");
  if (!state.db) { state.db = (await api.request<{ uuid: string }>("/d1/database", "POST", { name: `hearth-${name}` })).uuid; await save(state); }
  if (!state.kv) { state.kv = (await api.request<{ id: string }>("/storage/kv/namespaces", "POST", { title: `hearth-${name}` })).id; await save(state); }
  if (!state.token) {
    const token = await api.request<{ id: string; client_id: string; client_secret: string }>("/access/service_tokens", "POST", { name: `hearth-${name}`, duration: "168h" });
    Object.assign(state, { token: token.id, client_id: token.client_id, client_secret: token.client_secret }); await save(state);
  }
  if (!state.app) {
    const apps = await api.list<{ name: string; allowed_idps: string[]; policies: { name: string; decision: string; include: object[]; require?: object[]; exclude?: object[] }[] }>("/access/apps");
    const source = apps.find((app) => app.name === "Hearth");
    if (!source) throw new Error("Household Access policy missing");
    const app = await api.request<{ id: string; aud: string }>("/access/apps", "POST", {
      name: `hearth-${name}`, type: "self_hosted", domain: `${new URL(state.url).hostname}/authorize`,
      allowed_idps: source.allowed_idps, auto_redirect_to_identity: true, app_launcher_visible: false,
      policies: [...source.policies.filter((p) => ["allow", "deny"].includes(p.decision)).map(({ name, decision, include, require, exclude }) => ({ name, decision, include, require, exclude })),
        { name: "Preview OAuth testing", decision: "non_identity", include: [{ service_token: { token_id: state.token } }] }],
    });
    state.app = app.id; state.aud = app.aud; await save(state);
  }
  const config = { name: parent, main: resolve("tools/mcp-preview-worker.ts"), compatibility_date: "2026-09-08", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    previews: { vars: { MCP_ORIGIN: state.url, ACCESS_AUD: state.aud, PREVIEW_CLIENT_ID: state.client_id,
      AMP_EVAL_PROJECT_ID: identity.project_id, AMP_EVAL_USER_ID: identity.user_id },
      d1_databases: [{ binding: "DB", database_id: state.db, database_name: `hearth-${name}` }], kv_namespaces: [{ binding: "OAUTH_KV", id: state.kv }] } };
  const configPath = resolve(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const migrationPath = resolve(directory, "migrations.json");
  await writeFile(migrationPath, JSON.stringify({ d1_databases: [{ ...config.previews.d1_databases[0], migrations_dir: resolve("migrations") }] }));
  run(["d1", "migrations", "apply", "DB", "--remote", "--config", migrationPath]);
  run(["preview", "--name", name, "--config", configPath, "--ignore-base-config", "--json"]);
  console.log(JSON.stringify({ url: state.url, mcp: `${state.url}/mcp`, eval: `${state.url}/eval/mcp`, name,
    note: "Isolated D1/KV. Eval orbs use npx task mcp:eval -- connect <eval URL>, then reload MCP. Clean up with npx task mcp:preview -- down." }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
