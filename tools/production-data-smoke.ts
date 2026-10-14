import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { exportProduction, productionApi, productionDatabase, seedPreview, seedSql } from "./production-data.ts";

// Live production READ/export only. All writes go to throwaway local Worker/D1 or
// temporary lifecycle checkouts. Do not log assertion values or household exports.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scratch = await mkdtemp(resolve(tmpdir(), "hearth-data-smoke-"));
const source = new DatabaseSync(":memory:");
let worker: Miniflare | undefined;
try {
  const api = productionApi();
  const production = await productionDatabase(api);
  await assert.rejects(seedPreview(api, production, "hearth-preview-p261021-1111111111"), /Refusing production database/);
  const dump = await exportProduction(api);
  source.exec(dump);
  const { batches, counts } = await seedSql(dump);
  const schema = new DatabaseSync(":memory:");
  try {
    for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) schema.exec(await readFile(`migrations/${name}`, "utf8"));
    const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
    const output = await bundle.generate({ format: "esm" });
    await bundle.close();
    const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
    assert(entry?.type === "chunk", "Worker bundle present");
    worker = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "production-copy-smoke", modules: true, script: entry.code, compatibilityDate: "2026-09-08", d1Databases: ["DB"], bindings: { LOCAL_DEV: "true" } }] }));
    const db = await worker.getD1Database("DB");
    for (const row of schema.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all()) await db.prepare(String(row.sql)).run();
    for (const batch of batches) await db.batch(batch.split(/;\n(?=DROP|CREATE|INSERT|DELETE)|;\s*$/).filter((sql) => sql.trim()).map((sql) => db.prepare(sql)));
    for (const table of Object.keys(counts)) {
      const expected = source.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all();
      const actual = (await db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()).results;
      assert.equal(hash(actual), hash(expected), `${table}: exact row/column values match production export`);
    }
    const response = await worker.dispatchFetch("http://localhost/api/household");
    assert.equal(response.status, 200);
    const household = await response.json() as { recipes: unknown[]; groceries: unknown[]; meals: unknown[] };
    assert.equal(household.recipes.length, counts.recipes);
    assert.equal(household.groceries.length, counts.groceries);
    assert.equal(household.meals.length, counts.meals);
    console.log(JSON.stringify({ check: "Live export → real workerd/D1 → actual household API; all app table hashes match; production destination refused", counts }));
  } finally { schema.close(); }

  const checkout = async (name: string) => {
    const path = resolve(scratch, name);
    await mkdir(path, { mode: 0o700 });
    for (const file of ["Taskfile.yml", "package.json", "cloudflare.config.ts", ".agents/resume", "tools/production-data.ts", "tools/preview.ts", "src/install-assets.ts", "migrations"]) {
      const target = resolve(path, file);
      await mkdir(resolve(target, ".."), { recursive: true });
      await cp(resolve(file), target, { recursive: true });
    }
    await symlink(resolve("node_modules"), resolve(path, "node_modules"), "dir");
    return path;
  };
  const resume = (cwd: string, owner: string, credentials = true, action = "orb:resume") => {
    const env: NodeJS.ProcessEnv = { ...process.env, AMP_THREAD_ID: owner };
    if (!credentials) { delete env.CLOUDFLARE_ACCOUNT_ID; delete env.CLOUDFLARE_API_TOKEN; }
    try { execFileSync("npx", ["task", action], { cwd, env, stdio: "pipe", timeout: 180_000 }); return true; }
    catch { return false; } // Captured errors can contain private paths; do not print output.
  };
  const manifest = async (cwd: string) => JSON.parse(await readFile(resolve(cwd, ".hearth-data/seed.json"), "utf8"));
  const first = await checkout("first");
  const ownerA = "T-11111111-1111-1111-1111-111111111111";
  const ownerB = "T-22222222-2222-2222-2222-222222222222";
  const start = Date.now();
  assert(resume(first, ownerA), "Fresh activation exports successfully");
  const initial = await manifest(first);
  assert.equal(initial.owner, ownerA);
  assert(Date.parse(initial.exportedAt) >= start, "Fresh activation exports now");
  assert(resume(first, ownerA, false), "Same-owner resume succeeds even without cloud credentials");
  assert.equal(hash(await manifest(first)), hash(initial), "Same-owner resume preserves seed and stage");
  await mkdir(resolve(first, ".alchemy/local/d1"), { recursive: true });
  const cachedPath = resolve(first, ".alchemy/local/d1/cached.sqlite");
  const cached = new DatabaseSync(cachedPath);
  cached.exec("CREATE TABLE local_edit(value TEXT); INSERT INTO local_edit VALUES ('prior thread fixture');");
  cached.close();
  const cachedHash = hash(Array.from(await readFile(cachedPath)));
  const snapshot = await checkout("snapshot-reuse");
  await cp(resolve(first, ".hearth-data"), resolve(snapshot, ".hearth-data"), { recursive: true });
  await cp(resolve(first, ".alchemy"), resolve(snapshot, ".alchemy"), { recursive: true });
  const activated = Date.now();
  assert(resume(snapshot, ownerB), "Exact-snapshot activation runs resume without setup and refreshes another owner's seed");
  const fresh = await manifest(snapshot);
  assert.equal(fresh.owner, ownerB);
  assert.notEqual(fresh.directory, initial.directory, "Snapshot reuse selects a new database stage");
  const stage = execFileSync("node", ["tools/production-data.ts", "stage"], { cwd: snapshot, env: { ...process.env, AMP_THREAD_ID: ownerB }, encoding: "utf8" }).trim();
  assert.equal(stage, `seed-${fresh.directory}`, "Actual dev stage selector points at the newly exported copy");
  assert.equal(hash(Array.from(await readFile(resolve(snapshot, ".alchemy/local/d1/cached.sqlite")))), cachedHash, "Snapshot's old SQLite data is preserved, not reused or overwritten");
  assert(Date.parse(fresh.exportedAt) >= activated, "Snapshot reuse makes a current export, not a cached copy");
  assert(!resume(snapshot, ownerA, false), "Missing export credentials fails closed for a new owner");
  assert.equal(hash(await manifest(snapshot)), hash(fresh), "Failed export preserves previous local data");
  assert(resume(snapshot, ownerB, true, "data:reseed"), "Explicit reseed exports successfully");
  assert.notEqual((await manifest(snapshot)).directory, fresh.directory, "Explicit reseed selects a new database stage");
  const seedFiles = await readdir(resolve(snapshot, ".hearth-data", (await manifest(snapshot)).directory));
  assert(seedFiles.length > 0);
  console.log("PASS fresh resume; credential-free same-thread preservation; exact-snapshot reuse with new owner/fresh export/stage; missing-access fail-closed; explicit reseed. Temporary databases/exports removed in finally.");
} catch {
  console.error("FAIL production-data smoke (private details suppressed). Check Cloudflare export access and schema compatibility.");
  process.exitCode = 1;
} finally {
  source.close();
  await worker?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
