import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Cloudflare } from "./preview.ts";

const root = resolve(".hearth-data");
const manifestPath = resolve(root, "seed.json");
const seedSchema = z.object({
  owner: z.string(), exportedAt: z.iso.datetime(), directory: z.uuid(),
  files: z.array(z.string().regex(/^\d{4,}\.sql$/)),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
type Seed = z.infer<typeof seedSchema>;
const namedRowSchema = z.object({ name: z.string() });
const queryResultSchema = z.array(z.object({ success: z.literal(true) })).min(1);
const tableQuerySchema = z.array(z.object({ results: z.array(namedRowSchema) })).min(1);
const statusQuerySchema = z.array(z.object({ results: z.array(z.object({ status: z.string() })) })).min(1);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const internal = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_") || ["__alchemy_migrations", "d1_migrations"].includes(name);

/** Requires explicit production discovery/export credentials; never falls back to fixtures. */
export function productionApi(): Cloudflare {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Production seeding requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with production Worker binding discovery and D1 SQL export authorization. D1 Read alone is not assumed sufficient. No sample fallback; use dev:empty for fixture testing.");
  return new Cloudflare(account, token);
}

/** Discovers the unique production Website's DB binding without writing production resources. */
export async function productionDatabase(api: Cloudflare): Promise<string> {
  const workers = (await api.list("/workers/scripts", z.object({ id: z.string(), tags: z.array(z.string()).nullish() }))).filter((worker) =>
    ["alchemy:stack:hearth", "alchemy:stage:production", "alchemy:id:Website"].every((tag) => worker.tags?.includes(tag)),
  );
  if (workers.length !== 1) throw new Error("Expected exactly one production Hearth Website.");
  const settings = await api.request(`/workers/scripts/${workers[0].id}/settings`, z.object({ bindings: z.array(z.object({ type: z.string(), name: z.string(), id: z.string().optional(), database_id: z.string().optional() })) }));
  const db = settings.bindings.filter((binding) => binding.type === "d1" && binding.name === "DB");
  const id = db[0]?.database_id ?? db[0]?.id;
  if (db.length !== 1 || !id) throw new Error("Production DB binding missing or ambiguous.");
  return id;
}

/** Downloads a read-only production SQL export; signed URLs and household contents must stay private. */
export async function exportProduction(api: Cloudflare): Promise<string> {
  const id = await productionDatabase(api);
  let bookmark: string | undefined;
  for (let poll = 0; poll < 120; poll++) {
    const result = await api.request(`/d1/database/${id}/export`, z.object({ status: z.string(), at_bookmark: z.string().optional(), result: z.object({ signed_url: z.url().optional() }).optional() }), "POST", { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) });
    if (result.status === "complete" && result.result?.signed_url) {
      // Signed download URL is a credential: never log it or send the API token to it.
      const response = await fetch(result.result.signed_url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Production export download failed (HTTP ${response.status}).`);
      return response.text();
    }
    if (result.status === "error" || !result.at_bookmark) throw new Error("Production export failed; check D1 export permission.");
    bookmark = result.at_bookmark;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Production export timed out; no local data changed.");
}

/** Validates an export privately and builds data-only replacement batches for the checkout's migrated schema, preserving cells and restoring triggers. */
export async function seedSql(dump: string): Promise<{ batches: string[]; counts: Record<string, number> }> {
  const source = new DatabaseSync(":memory:");
  const target = new DatabaseSync(":memory:");
  try {
    source.exec(dump);
    const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    const history = z.array(namedRowSchema).parse(source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('__alchemy_migrations','d1_migrations')").all());
    if (history.length !== 1) throw new Error("Production migration history missing or ambiguous; refusing to guess schema compatibility.");
    const applied = new Set(z.array(namedRowSchema).parse(source.prepare(`SELECT name FROM ${quote(history[0].name)}`).all()).map((row) => row.name));
    for (const migration of migrations) {
      const sql = await readFile(resolve("migrations", migration), "utf8");
      target.exec(sql);
      if (!applied.has(migration)) source.exec(sql);
    }
    if ([...applied].some((name) => !migrations.includes(name))) throw new Error("Production schema is ahead of this checkout; update the branch before seeding.");
    const tables = (db: DatabaseSync) => z.array(namedRowSchema).parse(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).map((row) => row.name).filter((name) => !internal(name));
    const names = tables(target);
    if (JSON.stringify(tables(source)) !== JSON.stringify(names)) throw new Error("Production/checkout app tables differ; refusing partial copy.");
    const ordered: string[] = [];
    const visit = (name: string, visiting = new Set<string>()) => {
      if (ordered.includes(name)) return;
      if (visiting.has(name)) throw new Error("Cyclic foreign keys require a reviewed import strategy.");
      visiting.add(name);
      for (const fk of z.array(z.object({ table: z.string() })).parse(target.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all())) visit(fk.table, visiting);
      visiting.delete(name);
      ordered.push(name);
    };
    names.forEach((name) => visit(name));
    const triggers = z.array(namedRowSchema.extend({ sql: z.string() })).parse(target.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all());
    const lines = [`-- Fresh production export ${randomUUID()}; applied only to isolated databases.`,
      ...triggers.map((row) => `DROP TRIGGER IF EXISTS ${quote(row.name)};`),
      ...ordered.toReversed().map((name) => `DELETE FROM ${quote(name)};`),
      "DROP TABLE IF EXISTS __hearth_import_chunks;",
      "CREATE TABLE __hearth_import_chunks (cell INTEGER, position INTEGER, value TEXT NOT NULL, PRIMARY KEY(cell, position));",
    ];
    const literal = (value: SQLOutputValue): string => {
      if (value === null) return "NULL";
      if (typeof value === "bigint" || typeof value === "number") return String(value);
      if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
      // Hex literals preserve embedded NULs and Unicode exactly (SQLite quote() truncates at NUL).
      return `CAST(X'${Buffer.from(value).toString("hex")}' AS TEXT)`;
    };
    const counts: Record<string, number> = {};
    for (const name of ordered) {
      const columns = z.array(namedRowSchema).parse(source.prepare(`PRAGMA table_info(${quote(name)})`).all()).map((row) => row.name);
      const targetColumns = z.array(namedRowSchema).parse(target.prepare(`PRAGMA table_info(${quote(name)})`).all()).map((row) => row.name);
      if (JSON.stringify(columns) !== JSON.stringify(targetColumns)) throw new Error(`Schema mismatch in ${name}; no import performed.`);
      const statement = source.prepare(`SELECT * FROM ${quote(name)}`);
      statement.setReadBigInts(true);
      const rows = statement.all();
      counts[name] = rows.length;
      for (const row of rows) {
        const values = Object.values(row);
        const large = values.map((value, index) => Buffer.byteLength(literal(value)) > 4000 ? index : -1).filter((index) => index >= 0);
        // Split large text into bounded statements, then assemble it inside SQLite so CHECK
        // constraints only see the complete value. No truncation or partial JSON updates.
        if (large.length) lines.push("DELETE FROM __hearth_import_chunks;");
        for (const index of large) {
          const value = values[index];
          if (typeof value !== "string") throw new Error("Large non-text cells require a reviewed import strategy.");
          for (let offset = 0, position = 0; offset < value.length; position++) {
            let end = Math.min(offset + 4000, value.length);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
            lines.push(`INSERT INTO __hearth_import_chunks VALUES (${index}, ${position}, ${literal(value.slice(offset, end))});`);
            offset = end;
          }
        }
        lines.push(`INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES (${values.map((value, index) => large.includes(index) ? `(SELECT group_concat(value, '') FROM (SELECT value FROM __hearth_import_chunks WHERE cell=${index} ORDER BY position))` : literal(value)).join(",")});`);
      }
    }
    lines.push("DROP TABLE __hearth_import_chunks;", ...triggers.map((row) => `${row.sql};`));
    const sql = lines.join("\n");
    target.exec(sql);
    if (target.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Seed foreign-key check failed.");
    const batches: string[] = [];
    let batch = "";
    for (const line of lines) {
      if (Buffer.byteLength(line) > 80_000) throw new Error("Seed statement exceeds D1 limit; no import performed.");
      if (Buffer.byteLength(batch) + Buffer.byteLength(line) > 80_000) { batches.push(batch); batch = ""; }
      batch += `${line}\n`;
    }
    if (batch) batches.push(batch);
    return { batches, counts };
  } catch {
    throw new Error("Production seed validation failed: check migration history/schema compatibility and D1 limits. Household SQL and values suppressed.");
  } finally {
    source.close();
    target.close();
  }
}

/** Reads and validates the private seed manifest; only a missing manifest means unseeded. */
export async function localSeed(): Promise<Seed | undefined> {
  let manifest: string;
  try { manifest = await readFile(manifestPath, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  try { return seedSchema.parse(JSON.parse(manifest)); }
  catch { throw new Error("Local seed manifest is invalid; inspect local seed metadata before preparing data. Private contents suppressed."); }
}

/** Preserves same-owner snapshots unless reseeding; empty mode bypasses all production access. */
export async function prepareLocal(reseed = false): Promise<void> {
  if (process.env.HEARTH_EMPTY_DB === "1") return;
  await mkdir(resolve(".alchemy"), { recursive: true, mode: 0o700 });
  await chmod(resolve(".alchemy"), 0o700);
  const owner = process.env.AMP_THREAD_ID ?? "local";
  const existing = await localSeed();
  if (!reseed && existing?.owner === owner) {
    for (const file of existing.files) await readFile(resolve(root, existing.directory, file));
    console.log(`Preserving isolated ${owner} data (export ${existing.exportedAt}).`);
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  console.log("Exporting current production D1 for isolated development; household contents stay private.");
  const { batches, counts } = await seedSql(await exportProduction(productionApi()));
  const directory = randomUUID();
  await mkdir(resolve(root, directory), { mode: 0o700 });
  const files: string[] = [];
  for (const [index, sql] of batches.entries()) {
    const file = `${String(index).padStart(4, "0")}.sql`;
    await writeFile(resolve(root, directory, file), sql, { mode: 0o600 });
    files.push(file);
  }
  const seed: Seed = { owner, exportedAt: new Date().toISOString(), directory, files, counts };
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, JSON.stringify(seed, null, 2), { mode: 0o600 });
  await rename(temporary, manifestPath);
  if (existing?.directory) await rm(resolve(root, existing.directory), { recursive: true, force: true });
  console.log(JSON.stringify({ owner, exportedAt: seed.exportedAt, counts, note: "Private seed prepared; Alchemy imports before serving requests. No production writes." }));
}

/** Returns only the current owner's validated seed paths; empty mode skips importing. */
export async function localImportFiles(): Promise<string[] | undefined> {
  if (process.env.HEARTH_EMPTY_DB === "1") return;
  const seed = await localSeed();
  if (!seed || seed.owner !== (process.env.AMP_THREAD_ID ?? "local")) throw new Error("Run npx task data:prepare before local development. Cached seed belongs to another thread or is missing.");
  return seed.files.map((file) => resolve(root, seed.directory, file));
}

/** Reads durable seed intent; unknown intent requires explicit preservation or reseeding. */
export async function previewSeedPending(api: Cloudflare, id: string, allowUnmarked = false): Promise<boolean> {
  const tables = await api.request(`/d1/database/${id}/query`, tableQuerySchema, "POST", { sql: "SELECT name FROM sqlite_schema WHERE name='__hearth_seed'" });
  if (!tables[0].results.length) {
    if (allowUnmarked) return false;
    throw new Error("Preview seed intent is unknown (legacy database or interrupted initialization). Use up --empty to preserve its data, or up --reseed to refresh explicitly.");
  }
  const rows = await api.request(`/d1/database/${id}/query`, statusQuerySchema, "POST", { sql: "SELECT status FROM __hearth_seed WHERE id=1" });
  const status = rows[0].results[0]?.status;
  if (!status || !["pending", "complete", "empty"].includes(status)) {
    if (allowUnmarked) return false;
    throw new Error("Preview seed intent is incomplete; use up --reseed or tear down.");
  }
  return status === "pending";
}

/** Records intent before import; callers must supply a newly created disposable database ID. */
export async function initializePreviewSeed(api: Cloudflare, id: string, empty: boolean): Promise<void> {
  // Call only with the ID returned by creating a NEW disposable database, never an existing binding.
  // Persist intent before export/migrations so failures cannot turn a later up into an empty fallback.
  await api.request(`/d1/database/${id}/query`, queryResultSchema, "POST", { sql: `CREATE TABLE IF NOT EXISTS __hearth_seed (id INTEGER PRIMARY KEY, status TEXT NOT NULL); INSERT OR REPLACE INTO __hearth_seed VALUES(1,'${empty ? "empty" : "pending"}');` });
}

/** Replaces only a name-verified disposable Preview, refusing the production binding as destination. */
export async function seedPreview(api: Cloudflare, id: string, name: string): Promise<void> {
  const source = await productionDatabase(api);
  if (source === id) throw new Error("Refusing production database as seed destination.");
  const database = await api.request(`/d1/database/${id}`, z.object({ name: z.string() }));
  if (database.name !== name || !/^hearth-(?:preview-p\d{6}-[a-f0-9]{10}|p\d{6}-[a-f0-9]{10}-mcp)$/.test(name)) throw new Error("Refusing non-disposable seed destination.");
  const { batches, counts } = await seedSql(await exportProduction(api));
  // D1 query accepts multi-statement SQL; never print SQL or server errors that may quote it.
  try {
    await api.request(`/d1/database/${id}/query`, queryResultSchema, "POST", { sql: "CREATE TABLE IF NOT EXISTS __hearth_seed (id INTEGER PRIMARY KEY, status TEXT NOT NULL); INSERT OR REPLACE INTO __hearth_seed VALUES(1,'pending');" });
    for (const sql of batches) await api.request(`/d1/database/${id}/query`, queryResultSchema, "POST", { sql });
    await api.request(`/d1/database/${id}/query`, queryResultSchema, "POST", { sql: "UPDATE __hearth_seed SET status='complete' WHERE id=1" });
  }
  catch { throw new Error("Isolated Preview seed import failed; household SQL suppressed. Retry up or tear down the Preview."); }
  console.log(JSON.stringify({ seeded: name, exportedAt: new Date().toISOString(), counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  if (!["prepare", "reseed", "status", "stage"].includes(action)) throw new Error("Use npx task data:prepare | data:reseed | data:status.");
  (action === "stage" ? localSeed().then((seed) => { if (!seed || seed.owner !== (process.env.AMP_THREAD_ID ?? "local")) throw new Error("Seed ownership mismatch"); console.log(`seed-${seed.directory}`); }) : action === "status" ? localSeed().then((seed) => console.log(JSON.stringify(seed ? { owner: seed.owner, exportedAt: seed.exportedAt, counts: seed.counts } : { seeded: false }, null, 2))) : prepareLocal(action === "reseed"))
    .catch(() => { console.error("Production seeding failed; no sample fallback. Check Cloudflare Workers Scripts Read and D1 export access, current migration history, and connectivity. Household data and credentials suppressed."); process.exitCode = 1; });
}
