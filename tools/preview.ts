import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bindings, type WorkerConfig } from "cf/config";
import { z } from "zod";
import { workerRuntime } from "../cloudflare.config.ts";
import { publicInstallPaths } from "../src/install-assets.ts";
import { initializePreviewSeed, previewSeedPending, seedPreview } from "./production-data.ts";

const prefix = "hearth-preview-";
const stateRoot = resolve(".wrangler/hearth-previews");
const ownedName = /^p(\d{6})-([a-f0-9]{10})$/;
const day = 86_400_000;

const resourceSchema = z.object({ id: z.string(), name: z.string() });
const previewSchema = resourceSchema.extend({ urls: z.array(z.string()).optional() });
const databaseSchema = z.object({ uuid: z.string(), name: z.string() });
/** Access inventory metadata; authentication fields are validated only on the selected source. */
export const appInventorySchema = resourceSchema.passthrough();
const tokenSchema = resourceSchema.extend({ client_id: z.string(), client_secret: z.string().optional() });
const policySchema = z.object({
  name: z.string(), decision: z.string(), include: z.array(z.object({}).passthrough()),
  require: z.array(z.object({}).passthrough()).optional(), exclude: z.array(z.object({}).passthrough()).optional(),
}).passthrough();
/** Requires explicit source identity providers and policies before copying household access. */
export const sourceAuthSchema = z.object({
  allowed_idps: z.array(z.string()), policies: z.array(policySchema),
});
type Database = z.infer<typeof databaseSchema>;
type Token = z.infer<typeof tokenSchema>;
type Inventory = {
  previews: z.infer<typeof previewSchema>[];
  databases: Database[];
  apps: z.infer<typeof appInventorySchema>[];
  tokens: z.infer<typeof resourceSchema>[];
};
const previewStateSchema = z.object({ url: z.url() });
const householdSmokeSchema = z.object({
  recipes: z.array(z.object({}).passthrough()),
  extras: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** Derives a seven-day disposable resource identity from the full owning thread ID. */
export function previewName(thread: string, now = Date.now()): string {
  if (!/^T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread)) {
    throw new Error("Set AMP_THREAD_ID to the full owning Amp thread ID.");
  }
  const expiry = new Date(now + 7 * day).toISOString().slice(2, 10).replaceAll("-", "");
  return `p${expiry}-${createHash("sha256").update(thread).digest("hex").slice(0, 10)}`;
}

/** Rejects unmanaged names before deriving their UTC cleanup deadline. */
export function expiresAt(name: string): number {
  const match = ownedName.exec(name);
  if (!match) throw new Error(`Not a managed Hearth preview: ${name}`);
  const date = match[1];
  const expiry = Date.parse(`20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}T00:00:00Z`);
  if (!Number.isFinite(expiry)) throw new Error("Invalid preview expiry date.");
  return expiry;
}

/** Account-scoped operator API; never logs request bodies or credential-bearing results. */
export class Cloudflare {
  private account: string;
  private token: string;
  private transport: typeof fetch;

  /** Keeps the supplied account credentials private to this API client. */
  constructor(account: string, token: string, transport: typeof fetch = fetch) {
    this.account = account;
    this.token = token;
    this.transport = transport;
  }

  /** Calls the account API; callers own the endpoint-specific result contract. */
  async request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: object): Promise<T> {
    const response = await this.transport(
      `https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const errors = z.object({ errors: z.array(z.object({ code: z.number() })).nullish() }).safeParse(payload);
    if (!response.ok) {
      throw new Error(`${method} ${path}: HTTP ${response.status}; Cloudflare error codes: ${errors.success ? errors.data.errors?.map((e) => e.code).join("; ") ?? "none" : "none"}`);
    }
    const envelope = z.object({
      success: z.boolean(), result: z.unknown().optional(),
      errors: z.array(z.object({ code: z.number() })).nullish(),
    }).safeParse(payload);
    if (!envelope.success) {
      throw new Error(`${method} ${path}: response envelope failed at ${envelope.error.issues.map(issue => `${issue.path.join(".") || "response"} (${issue.code})`).join("; ")}. Check the API contract before retrying.`);
    }
    const data = envelope.data;
    if (!data.success) {
      // Never print request bodies, headers, or returned credential objects.
      throw new Error(
        `${method} ${path}: HTTP ${response.status}; Cloudflare error codes: ${data.errors?.map((e) => e.code).join("; ") ?? "none"}`,
      );
    }
    const result = schema.safeParse(data.result);
    if (!result.success) {
      throw new Error(`${method} ${path}: response contract failed at ${result.error.issues.map(issue => `${issue.path.join(".") || "result"} (${issue.code})`).join("; ")}. Check the API contract before retrying.`);
    }
    return result.data;
  }

  /** Reads all account API pages without retaining response credentials in logs. */
  async list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`${path}?per_page=100&page=${page}`, z.array(schema));
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
}

/** Builds an isolated D1 configuration and refuses non-Preview database names. */
export function previewConfig(worker: string, db: Database, audience: string, clientId: string): WorkerConfig {
  if (!db.name.startsWith(prefix)) throw new Error("Refusing a non-preview database.");
  expiresAt(db.name.slice(prefix.length));
  return {
    name: worker,
    entrypoint: resolve(workerRuntime.main),
    compatibilityDate: workerRuntime.compatibilityDate,
    assets: {
      notFoundHandling: workerRuntime.assets.notFoundHandling,
      runWorkerFirst: workerRuntime.assets.runWorkerFirst,
    },
    env: {
      LOCAL_DEV: bindings.text("false"),
      ACCESS_AUD: bindings.text(audience),
      PREVIEW_CLIENT_ID: bindings.text(clientId),
      AI: bindings.ai(),
      DB: bindings.d1({ name: db.name, id: db.uuid }),
      ASSETS: bindings.assets(),
    },
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  };
}

/** Owns disposable website Preview inventory and consumer-first cleanup. */
export class Previews {
  /** Account API path under the selected production-owned parent Worker. */
  readonly path: string;
  /** Account client used for inventory and lifecycle operations. */
  readonly api: Cloudflare;
  /** Parent Worker identity; never a disposable database identity. */
  readonly worker: string;

  /** Selects a parent without modifying its production configuration. */
  constructor(api: Cloudflare, worker: string) {
    this.api = api;
    this.worker = worker;
    this.path = `/workers/workers/${worker}/previews`;
  }

  /** Reads Preview, D1, Access application, and token metadata in parallel. */
  async inventory(): Promise<Inventory> {
    const [previews, databases, apps, tokens] = await Promise.all([
      this.api.list(this.path, previewSchema),
      this.api.list("/d1/database", databaseSchema),
      this.api.list("/access/apps", appInventorySchema),
      this.api.list("/access/service_tokens", resourceSchema),
    ]);
    return { previews, databases, apps, tokens };
  }

  /** Includes orphaned dependencies so interrupted provisioning remains destroyable. */
  names(inventory: Inventory): string[] {
    return [
      ...new Set([
        ...inventory.previews.map((p) => p.name),
        ...[...inventory.databases, ...inventory.apps, ...inventory.tokens]
          .filter((r) => r.name.startsWith(prefix))
          .map((r) => r.name.slice(prefix.length).replace(/-install$/, "")),
      ]),
    ].filter((name) => ownedName.test(name));
  }

  /** Confirms deployment deletion before removing protection, data, or local secrets. */
  async down(name: string): Promise<void> {
    expiresAt(name);
    const inventory = await this.inventory();
    const preview = inventory.previews.find((p) => p.name === name);
    // Keep Access and D1 intact if Preview deletion fails. Never unprotect a live deployment.
    if (preview) await this.api.request(`${this.path}/${preview.id}`, z.unknown(), "DELETE");
    if ((await this.api.list(this.path, previewSchema)).some((p) => p.name === name)) {
      throw new Error("Preview still exists; retry teardown after deletion propagates.");
    }
    for (const db of inventory.databases.filter((r) => r.name === prefix + name)) {
      await this.api.request(`/d1/database/${db.uuid}`, z.unknown(), "DELETE");
    }
    for (const app of inventory.apps.filter((r) => r.name === prefix + name || r.name === `${prefix}${name}-install`)) {
      await this.api.request(`/access/apps/${app.id}`, z.unknown(), "DELETE");
    }
    for (const token of inventory.tokens.filter((r) => r.name === prefix + name)) {
      await this.api.request(`/access/service_tokens/${token.id}`, z.unknown(), "DELETE");
    }
    if (this.names(await this.inventory()).includes(name)) throw new Error("Cleanup incomplete; retry down.");
    await rm(resolve(stateRoot, name), { recursive: true, force: true });
    console.log(`Deleted ${name}: Preview, D1, Access application, service token, local credentials.`);
  }

  /** Deletes only managed resources whose encoded cleanup deadline has passed. */
  async gc(now = Date.now()): Promise<void> {
    for (const name of this.names(await this.inventory())) {
      if (expiresAt(name) <= now) await this.down(name);
    }
  }
}

function command(bin: string, args: string[], capture = false, env: NodeJS.ProcessEnv = {}): string {
  return (
    execFileSync(bin, args, {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: { ...process.env, ...env, CI: "true", CF_SEND_TELEMETRY: "false" },
    }) ?? ""
  );
}

async function save(path: string, value: object): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Provisions isolated dependencies; rolls back new resources but preserves failed updates.
 * @param runCommand Executes migrations before deployment; captures deployment stdout only.
 * @param verify Runs the authenticated persistence/Access smoke after saving deployment metadata.
 */
export async function up(
  manager: Previews,
  name: string,
  sourceApp: z.infer<typeof sourceAuthSchema>,
  runCommand = command,
  verify = smoke,
  seedMode: "production" | "empty" | "reseed" = "production",
): Promise<void> {
  const directory = resolve(stateRoot, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await manager.inventory();
  const isNew = !manager.names(before).includes(name);
  try {
    const preview =
      before.previews.find((p) => p.name === name) ??
      (await manager.api.request(`${manager.path}?ignore_base_config=true`, previewSchema, "POST", { name }));
    const url = preview.urls?.find((u) => new URL(u).hostname.endsWith(".workers.dev"));
    if (!url) throw new Error("Preview has no workers.dev URL; production settings were not changed.");
    const resourceName = prefix + name;
    let token = before.tokens.find((t) => t.name === resourceName);
    let credentials: Token | undefined;
    try {
      credentials = tokenSchema.parse(JSON.parse(await readFile(resolve(directory, "credentials.json"), "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!token || token.id !== credentials?.id) {
      // Referenced tokens cannot be deleted. Rotate the secret in place when a new orb lacks it.
      credentials = token
        ? await manager.api.request(`/access/service_tokens/${token.id}/rotate`, tokenSchema, "POST", {})
        : await manager.api.request("/access/service_tokens", tokenSchema, "POST", {
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
    const app = await manager.api.request(
      `/access/apps${oldApp ? `/${oldApp.id}` : ""}`,
      z.object({ aud: z.string() }),
      oldApp ? "PUT" : "POST",
      appBody,
    );
    const installName = `${resourceName}-install`;
    const oldInstallApp = before.apps.find((a) => a.name === installName);
    await manager.api.request(
      `/access/apps${oldInstallApp ? `/${oldInstallApp.id}` : ""}`,
      z.unknown(),
      oldInstallApp ? "PUT" : "POST",
      {
        name: installName,
        type: "self_hosted",
        app_launcher_visible: false,
        destinations: publicInstallPaths.map((path) => ({ type: "public", uri: new URL(url).hostname + path })),
        policies: [{ name: "Public installation files", decision: "bypass", include: [{ everyone: {} }] }],
      },
    );
    const db =
      before.databases.find((d) => d.name === resourceName) ??
      (await manager.api.request("/d1/database", databaseSchema, "POST", { name: resourceName }));
    if (!before.databases.some((d) => d.uuid === db.uuid)) await initializePreviewSeed(manager.api, db.uuid, seedMode === "empty");
    const config = previewConfig(manager.worker, db, app.aud, tokenSchema.parse(credentials).client_id);
    const configPath = resolve(directory, "worker.json");
    await save(configPath, config);
    runCommand("npx", ["cf", "d1", "migrations", "apply", db.uuid, "--dir", resolve("migrations"), "--table", "d1_migrations"]);
    const pendingSeed = await previewSeedPending(manager.api, db.uuid, seedMode !== "production");
    if (pendingSeed && seedMode === "empty") throw new Error("Preview seed is incomplete; retry up or tear down before empty-fixture testing.");
    if (seedMode === "reseed" || pendingSeed || (seedMode === "production" && !before.databases.some((d) => d.uuid === db.uuid))) {
      await seedPreview(manager.api, db.uuid, resourceName);
    }
    // Precreation above must retain ignore_base_config=true: cf has no equivalent CLI flag.
    runCommand(
      "npx",
      ["cf", "previews", "deploy", name, "--mode", "cf-preview"],
      true,
      { HEARTH_PREVIEW_CONFIG: configPath },
    );
    // Read authoritative deployment metadata instead of coupling to beta CLI output.
    const deployed = await manager.api.request(
      `${manager.path}/${preview.id}/deployments/latest`,
      z.object({ id: z.string() }),
    );
    const current = await manager.api.request(`${manager.path}/${preview.id}`, previewSchema);
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
      } catch {
        console.error(`Rollback incomplete. Run npx task preview -- down ${name}.`);
      }
    } else console.error(`Existing Preview preserved. Retry up or run npx task preview -- down ${name}.`);
    throw error;
  }
}

/**
 * Sends local service credentials only to the saved origin; retries only Access rejections.
 * @param transport Must honor manual redirects to avoid forwarding service credentials.
 * @param wait Delays between Access propagation checks, never ambiguous write failures.
 */
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
  const { url } = previewStateSchema.parse(JSON.parse(await readFile(resolve(directory, "preview.json"), "utf8")));
  const token = tokenSchema.parse(JSON.parse(await readFile(resolve(directory, "credentials.json"), "utf8")));
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
  const { url } = previewStateSchema.parse(JSON.parse(await readFile(resolve(directory, "preview.json"), "utf8")));
  for (const path of ["/", "/api/household", "/brand/", "/favicon.ico", "/icons/favicon-32.png", "/icons/missing.png", "/apple-touch-icon.png/private", "/site.webmanifest/private"]) {
    const anonymous = await fetch(url + path, { redirect: "manual" });
    if (![302, 401, 403].includes(anonymous.status))
      throw new Error(`Unauthenticated ${path} returned ${anonymous.status}`);
    await anonymous.body?.cancel();
  }
  for (const path of publicInstallPaths) {
    const asset = await fetch(url + path, { redirect: "manual" });
    if (asset.status !== 200) throw new Error(`Public installation file ${path} returned ${asset.status}`);
    if (path.endsWith(".png")) {
      const bytes = Buffer.from(await asset.arrayBuffer());
      if (!asset.headers.get("Content-Type")?.includes("image/png") || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error(`Public installation file ${path} is not a PNG`);
      }
    } else {
      if (!asset.headers.get("Content-Type")?.includes("application/manifest+json")) throw new Error("Manifest content type missing.");
      const manifest = z.object({ short_name: z.string(), icons: z.array(z.object({ src: z.string() })) }).parse(await asset.json());
      if (manifest.short_name !== "Hearth" || manifest.icons.length !== 4 || manifest.icons.some((icon) => !publicInstallPaths.includes(icon.src))) {
        throw new Error("Public manifest identity or icon URLs are incorrect.");
      }
    }
    const head = await fetch(url + path, { method: "HEAD", redirect: "manual" });
    if (head.status !== 200) throw new Error(`Public HEAD ${path} returned ${head.status}`);
    const write = await fetch(url + path, { method: "POST", redirect: "manual" });
    if (write.status !== 403) throw new Error(`Public POST ${path} returned ${write.status}`);
    await write.body?.cancel();
  }
  const response = await previewFetch(name, "/api/household");
  if (!response.ok) throw new Error(`Authenticated API returned ${response.status}`);
  const initial = householdSmokeSchema.parse(await response.json());
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
    const household = householdSmokeSchema.parse(await (await previewFetch(name, "/api/household")).json());
    if (!household.extras.some((e) => e.id === id && e.name === "Preview persistence check"))
      throw new Error("D1 read-after-write failed.");
  } finally {
    const deleted = await previewFetch(name, `/api/extras/${id}`, "DELETE", "{}");
    if (!deleted.ok) throw new Error(`Smoke fixture cleanup failed: ${deleted.status}`);
  }
  const final = householdSmokeSchema.parse(await (await previewFetch(name, "/api/household")).json());
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
        checks: "anonymous installation PNGs/manifest and HEAD allowed; other anonymous paths and installation POST denied; authenticated HTML, JS and API; D1 write/read/delete",
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
  const [action = "help", option, method, path, body] = process.argv.slice(2);
  const seedMode = action === "up" && option === "--empty" ? "empty" : action === "up" && option === "--reseed" ? "reseed" : "production";
  const argument = action === "up" && ["--empty", "--reseed"].includes(option) ? undefined : option;
  if (!["up", "down", "list", "gc", "test", "request"].includes(action)) {
    console.log(
      "npx task preview -- up [--empty|--reseed] | list | gc | down [name] | test [name] | request <name> <METHOD> </path> [JSON]\nNew D1 seeds current production unless --empty. Updates preserve data unless --reseed. --empty never clears existing data. up/gc removes expired resources. Use down when review ends.",
    );
    return;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  const api = new Cloudflare(account, token);
  const scripts = await api.list("/workers/scripts", z.object({ id: z.string(), tag: z.string(), tags: z.array(z.string()).nullish() }));
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
            installAccess: inventory.apps.some((p) => p.name === `${prefix}${name}-install`),
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
      z.object({ destinations: z.array(z.object({ type: z.string(), worker_id: z.string().optional() })) }).safeParse(app).data?.destinations.some((d) => d.type === "worker" && d.worker_id === worker.tag),
  );
  if (!sourceApp)
    throw new Error("Production Access allow policy not found; refusing to create a Preview.");
  const sourceAuth = sourceAuthSchema.parse(sourceApp);
  if (!sourceAuth.policies.some((p) => p.decision === "allow"))
    throw new Error("Production Access allow policy not found; refusing to create a Preview.");
  const settings = await api.request(
    `/workers/scripts/${worker.id}/subdomain`,
    z.object({ previews_enabled: z.boolean() }),
  );
  if (!settings.previews_enabled)
    throw new Error("workers.dev Preview URLs are disabled. Configure through the production owner first.");
  await manager.gc();
  await up(manager, expiresAt(name) <= Date.now() ? generated : name, sourceAuth, command, smoke, seedMode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof z.ZodError || error instanceof SyntaxError ? "Preview data failed validation; inspect local state and resource inventory before retrying." : error instanceof Error ? error.message : "Preview command failed; inspect resource inventory before retrying.");
    process.exitCode = 1;
  });
}
