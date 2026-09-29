import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workerRuntime } from "../cloudflare.config.ts";

const prefix = "hearth-preview-";
const stateRoot = resolve(".wrangler/hearth-previews");
const ownedName = /^p(\d{6})-([a-f0-9]{10})$/;
const day = 86_400_000;

type Resource = { id: string; name: string };
type Preview = Resource & { urls?: string[] };
type Database = Resource & { uuid: string };
type Token = Resource & { client_id: string; client_secret?: string };
type Policy = { name: string; decision: string; include: object[]; require?: object[]; exclude?: object[] };
type App = Resource & {
  aud: string;
  domain?: string;
  allowed_idps: string[];
  policies: Policy[];
  destinations?: { type: string; worker_id?: string }[];
};
type Script = { id: string; tag: string; tags?: string[] };
type Inventory = { previews: Preview[]; databases: Database[]; apps: App[]; tokens: Token[] };

export function previewName(thread: string, now = Date.now()): string {
  if (!/^T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread)) {
    throw new Error("Set AMP_THREAD_ID to the full owning Amp thread ID.");
  }
  const expiry = new Date(now + 7 * day).toISOString().slice(2, 10).replaceAll("-", "");
  return `p${expiry}-${createHash("sha256").update(thread).digest("hex").slice(0, 10)}`;
}

export function expiresAt(name: string): number {
  const match = ownedName.exec(name);
  if (!match) throw new Error(`Not a managed Hearth preview: ${name}`);
  const date = match[1];
  const expiry = Date.parse(`20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}T00:00:00Z`);
  if (!Number.isFinite(expiry)) throw new Error("Invalid preview expiry date.");
  return expiry;
}

export class Cloudflare {
  private account: string;
  private token: string;
  private transport: typeof fetch;

  constructor(account: string, token: string, transport: typeof fetch = fetch) {
    this.account = account;
    this.token = token;
    this.transport = transport;
  }

  async request<T>(path: string, method = "GET", body?: object): Promise<T> {
    const response = await this.transport(
      `https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      },
    );
    const data = (await response.json()) as {
      success: boolean;
      result: T;
      errors?: { code: number; message: string }[];
    };
    if (!response.ok || !data.success) {
      // Never print request bodies, headers, or returned credential objects.
      throw new Error(
        `${method} ${path}: HTTP ${response.status}; ${data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ")}`,
      );
    }
    return data.result;
  }

  async list<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(`${path}?per_page=100&page=${page}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
}

export function previewConfig(worker: string, db: Database, audience: string, clientId: string) {
  if (!db.name.startsWith(prefix)) throw new Error("Refusing a non-preview database.");
  expiresAt(db.name.slice(prefix.length));
  return {
    name: worker,
    main: resolve(workerRuntime.main),
    compatibility_date: workerRuntime.compatibilityDate,
    assets: {
      directory: resolve(workerRuntime.assets.directory),
      binding: workerRuntime.assets.binding,
      not_found_handling: workerRuntime.assets.notFoundHandling,
      run_worker_first: workerRuntime.assets.runWorkerFirst,
    },
    previews: {
      vars: { LOCAL_DEV: "false", ACCESS_AUD: audience, PREVIEW_CLIENT_ID: clientId },
      d1_databases: [{ binding: "DB", database_name: db.name, database_id: db.uuid }],
      observability: { enabled: true, logs: { enabled: true, invocation_logs: true } },
    },
  };
}

export class Previews {
  readonly path: string;
  readonly api: Cloudflare;
  readonly worker: string;

  constructor(api: Cloudflare, worker: string) {
    this.api = api;
    this.worker = worker;
    this.path = `/workers/workers/${worker}/previews`;
  }

  async inventory(): Promise<Inventory> {
    const [previews, databases, apps, tokens] = await Promise.all([
      this.api.list<Preview>(this.path),
      this.api.list<Database>("/d1/database"),
      this.api.list<App>("/access/apps"),
      this.api.list<Token>("/access/service_tokens"),
    ]);
    return { previews, databases, apps, tokens };
  }

  names(inventory: Inventory): string[] {
    return [
      ...new Set([
        ...inventory.previews.map((p) => p.name),
        ...[...inventory.databases, ...inventory.apps, ...inventory.tokens]
          .filter((r) => r.name.startsWith(prefix))
          .map((r) => r.name.slice(prefix.length)),
      ]),
    ].filter((name) => ownedName.test(name));
  }

  async down(name: string): Promise<void> {
    expiresAt(name);
    const inventory = await this.inventory();
    const preview = inventory.previews.find((p) => p.name === name);
    // Keep Access and D1 intact if Preview deletion fails. Never unprotect a live deployment.
    if (preview) await this.api.request(`${this.path}/${preview.id}`, "DELETE");
    if ((await this.api.list<Preview>(this.path)).some((p) => p.name === name)) {
      throw new Error("Preview still exists; retry teardown after deletion propagates.");
    }
    for (const db of inventory.databases.filter((r) => r.name === prefix + name)) {
      await this.api.request(`/d1/database/${db.uuid}`, "DELETE");
    }
    for (const app of inventory.apps.filter((r) => r.name === prefix + name)) {
      await this.api.request(`/access/apps/${app.id}`, "DELETE");
    }
    for (const token of inventory.tokens.filter((r) => r.name === prefix + name)) {
      await this.api.request(`/access/service_tokens/${token.id}`, "DELETE");
    }
    if (this.names(await this.inventory()).includes(name)) throw new Error("Cleanup incomplete; retry down.");
    await rm(resolve(stateRoot, name), { recursive: true, force: true });
    console.log(`Deleted ${name}: Preview, D1, Access application, service token, local credentials.`);
  }

  async gc(now = Date.now()): Promise<void> {
    for (const name of this.names(await this.inventory())) {
      if (expiresAt(name) <= now) await this.down(name);
    }
  }
}

function command(bin: string, args: string[], capture = false): string {
  return (
    execFileSync(bin, args, {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    }) ?? ""
  );
}

async function save(path: string, value: object): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export async function up(
  manager: Previews,
  name: string,
  sourceApp: App,
  runCommand = command,
  verify = smoke,
): Promise<void> {
  const directory = resolve(stateRoot, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await manager.inventory();
  const isNew = !manager.names(before).includes(name);
  try {
    const preview =
      before.previews.find((p) => p.name === name) ??
      (await manager.api.request<Preview>(`${manager.path}?ignore_base_config=true`, "POST", { name }));
    const url = preview.urls?.find((u) => new URL(u).hostname.endsWith(".workers.dev"));
    if (!url) throw new Error("Preview has no workers.dev URL; production settings were not changed.");
    const resourceName = prefix + name;
    let token = before.tokens.find((t) => t.name === resourceName);
    let credentials: Token | undefined;
    try {
      credentials = JSON.parse(await readFile(resolve(directory, "credentials.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!token || token.id !== credentials?.id) {
      // Referenced tokens cannot be deleted. Rotate the secret in place when a new orb lacks it.
      credentials = token
        ? await manager.api.request<Token>(`/access/service_tokens/${token.id}/rotate`, "POST", {})
        : await manager.api.request<Token>("/access/service_tokens", "POST", {
            name: resourceName,
            duration: "168h",
          });
      await save(resolve(directory, "credentials.json"), credentials);
      token = credentials;
    }
    const appBody = {
      name: resourceName,
      type: "self_hosted",
      domain: new URL(url).hostname,
      session_duration: "24h",
      allowed_idps: sourceApp.allowed_idps,
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
      policies: [
        ...sourceApp.policies
          .filter((p) => p.decision === "allow" || p.decision === "deny")
          .map((p) => ({
            name: p.name,
            decision: p.decision,
            include: p.include,
            require: p.require,
            exclude: p.exclude,
          })),
        {
          name: "Preview automation",
          decision: "non_identity",
          include: [{ service_token: { token_id: token.id } }],
        },
      ],
    };
    const oldApp = before.apps.find((a) => a.name === resourceName);
    const app = await manager.api.request<App>(
      `/access/apps${oldApp ? `/${oldApp.id}` : ""}`,
      oldApp ? "PUT" : "POST",
      appBody,
    );
    const db =
      before.databases.find((d) => d.name === resourceName) ??
      (await manager.api.request<Database>("/d1/database", "POST", { name: resourceName }));
    const config = previewConfig(manager.worker, db, app.aud, token.client_id);
    const configPath = resolve(directory, "wrangler.json");
    await save(configPath, config);
    const migrationPath = resolve(directory, "migrations.json");
    await save(migrationPath, {
      d1_databases: [{ ...config.previews.d1_databases[0], migrations_dir: resolve("migrations") }],
    });
    runCommand("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", migrationPath]);
    runCommand(
      "npx",
      ["wrangler", "preview", "--name", name, "--config", configPath, "--ignore-base-config", "--json"],
      true,
    );
    // Wrangler's asset uploader writes progress to stdout even with --json.
    // Read authoritative deployment metadata instead of parsing mixed CLI output.
    const deployed = await manager.api.request<{ id: string }>(
      `${manager.path}/${preview.id}/deployments/latest`,
    );
    const current = await manager.api.request<Preview>(`${manager.path}/${preview.id}`);
    if (!current.urls?.includes(url))
      throw new Error("Preview URL changed; inspect Access configuration before sharing.");
    await save(resolve(directory, "preview.json"), {
      name,
      url,
      deployment: deployed.id,
      expires: new Date(expiresAt(name)).toISOString(),
    });
    await verify(name);
    console.log(
      JSON.stringify(
        { name, url, deployment: deployed.id, expires: new Date(expiresAt(name)).toISOString() },
        null,
        2,
      ),
    );
  } catch (error) {
    if (isNew) {
      try {
        await manager.down(name);
      } catch (cleanup) {
        console.error(`Rollback incomplete. Run npx task preview -- down ${name}.`, cleanup);
      }
    } else console.error(`Existing Preview preserved. Retry up or run npx task preview -- down ${name}.`);
    throw error;
  }
}

export async function previewFetch(
  name: string,
  path: string,
  method = "GET",
  body?: string,
  transport = fetch,
  wait = () => new Promise<void>((done) => setTimeout(done, 5_000)),
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Use an absolute path, not a URL.");
  const directory = resolve(stateRoot, name);
  const { url } = JSON.parse(await readFile(resolve(directory, "preview.json"), "utf8")) as { url: string };
  const token = JSON.parse(await readFile(resolve(directory, "credentials.json"), "utf8")) as Token;
  if (!token.client_secret) throw new Error("No local service secret; run up to rotate the Preview token.");
  const target = new URL(path, url);
  if (target.origin !== new URL(url).origin) throw new Error("Cross-origin preview request refused.");
  for (let attempt = 0; ; attempt++) {
    const response = await transport(target, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "CF-Access-Client-Id": token.client_id,
        "CF-Access-Client-Secret": token.client_secret,
        "Content-Type": "application/json",
      },
    });
    // Newly created/rotated Access policies can briefly disagree across edges.
    // Only retry authentication rejections, never ambiguous network errors or 5xx writes.
    if (![302, 401, 403].includes(response.status) || attempt >= 11) return response;
    await response.body?.cancel();
    await wait();
  }
}

async function smoke(name: string): Promise<void> {
  const directory = resolve(stateRoot, name);
  const { url } = JSON.parse(await readFile(resolve(directory, "preview.json"), "utf8")) as { url: string };
  for (const path of ["/", "/api/household"]) {
    const anonymous = await fetch(url + path, { redirect: "manual" });
    if (![302, 401, 403].includes(anonymous.status))
      throw new Error(`Unauthenticated ${path} returned ${anonymous.status}`);
  }
  const response = await previewFetch(name, "/api/household");
  if (!response.ok) throw new Error(`Authenticated API returned ${response.status}`);
  const initial = (await response.json()) as {
    recipes: object[];
    meals: object[];
    extras: { id: string; name: string }[];
    checks: object[];
  };
  if (!Array.isArray(initial.recipes) || !Array.isArray(initial.extras))
    throw new Error("Invalid household response.");
  const html = await previewFetch(name, "/");
  const markup = await html.text();
  if (!html.ok || !markup.includes('<div id="root">')) throw new Error("Static HTML missing.");
  const asset = markup.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  if (!asset) throw new Error("JavaScript asset URL missing.");
  const javascript = await previewFetch(name, asset);
  if (!javascript.ok || !javascript.headers.get("Content-Type")?.includes("javascript")) {
    throw new Error("JavaScript asset missing.");
  }
  const id = `preview-smoke-${randomUUID()}`;
  try {
    const saved = await previewFetch(
      name,
      "/api/extras",
      "PUT",
      JSON.stringify({ id, name: "Preview persistence check", checked: 0 }),
    );
    if (!saved.ok) throw new Error(`D1 write failed: ${saved.status}`);
    const household = (await (await previewFetch(name, "/api/household")).json()) as typeof initial;
    if (!household.extras.some((e) => e.id === id && e.name === "Preview persistence check"))
      throw new Error("D1 read-after-write failed.");
  } finally {
    const deleted = await previewFetch(name, `/api/extras/${id}`, "DELETE", "{}");
    if (!deleted.ok) throw new Error(`Smoke fixture cleanup failed: ${deleted.status}`);
  }
  const final = (await (await previewFetch(name, "/api/household")).json()) as typeof initial;
  if (final.extras.some((e) => e.id === id)) throw new Error("D1 delete did not persist.");
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const result = await previewFetch(name, "/api/household");
    if (!result.ok) throw new Error(`Timing request failed: ${result.status}`);
    await result.json();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        name,
        checks: "anonymous denied; authenticated HTML, JS and API; D1 write/read/delete",
        samples: 10,
        medianMs: (samples[4] + samples[5]) / 2,
        maxMs: samples[9],
        note: "Warm end-to-end latency from this orb, including Access/network; not Worker CPU or a load test.",
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [action = "help", argument, method, path, body] = process.argv.slice(2);
  if (!["up", "down", "list", "gc", "test", "request"].includes(action)) {
    console.log(
      "npx task preview -- up | list | gc | down [name] | test [name] | request <name> <METHOD> </path> [JSON]\nup/gc removes resources past their seven-day cleanup deadline. No background timer runs. Use down when review ends.",
    );
    return;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  const api = new Cloudflare(account, token);
  const scripts = await api.list<Script>("/workers/scripts");
  const workers = scripts.filter((s) =>
    ["alchemy:stack:hearth", "alchemy:stage:production", "alchemy:id:Website"].every((tag) =>
      s.tags?.includes(tag),
    ),
  );
  if (workers.length !== 1)
    throw new Error("Expected exactly one Alchemy Hearth production Website; refusing ambiguous target.");
  const worker = workers[0];
  const manager = new Previews(api, worker.id);
  if (action === "gc") return manager.gc();
  const inventory = await manager.inventory();
  const names = manager.names(inventory);
  if (action === "list") {
    console.log(
      JSON.stringify(
        names.map((name) => ({
          name,
          expires: new Date(expiresAt(name)).toISOString(),
          urls: inventory.previews.find((p) => p.name === name)?.urls ?? [],
          resources: {
            preview: inventory.previews.some((p) => p.name === name),
            database: inventory.databases.some((p) => p.name === prefix + name),
            access: inventory.apps.some((p) => p.name === prefix + name),
            token: inventory.tokens.some((p) => p.name === prefix + name),
          },
        })),
        null,
        2,
      ),
    );
    return;
  }
  const generated = argument ?? previewName(process.env.AMP_THREAD_ID ?? "");
  const name = argument ?? names.find((n) => n.slice(8) === generated.slice(8)) ?? generated;
  expiresAt(name);
  if (action === "down") return manager.down(name);
  if (action === "test") return smoke(name);
  if (action === "request") {
    if (!method || !path) throw new Error("request requires name, method, path, and optional JSON body.");
    const response = await previewFetch(name, path, method, body);
    console.log(`HTTP ${response.status}\n${await response.text()}`);
    if (!response.ok) throw new Error("Preview request failed.");
    return;
  }
  if (argument)
    throw new Error("up derives ownership from AMP_THREAD_ID; it does not accept another thread's name.");
  if (
    command("git", ["branch", "--show-current"], true).trim().startsWith(`${process.env.AMP_THREAD_ID}-`) ===
    false
  ) {
    throw new Error("Create this thread's working branch before deploying a Preview.");
  }
  const sourceApp = inventory.apps.find(
    (app) =>
      app.name === "Hearth" &&
      app.destinations?.some((d) => d.type === "worker" && d.worker_id === worker.tag),
  );
  if (!sourceApp?.policies.some((p) => p.decision === "allow"))
    throw new Error("Production Access allow policy not found; refusing to create a Preview.");
  const settings = await api.request<{ previews_enabled: boolean }>(
    `/workers/scripts/${worker.id}/subdomain`,
  );
  if (!settings.previews_enabled)
    throw new Error("workers.dev Preview URLs are disabled. Configure through the production owner first.");
  command("npm", ["run", "build"]);
  await manager.gc();
  await up(manager, expiresAt(name) <= Date.now() ? generated : name, sourceApp);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
