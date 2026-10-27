import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { Schema } from "effect";
import { z } from "zod";
import { HouseholdSchema } from "../src/domain.ts";
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
  const namedRows = z.array(z.object({ name: z.string() }));
  const history = namedRows.parse(source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('__alchemy_migrations','d1_migrations')").all());
  assert.equal(history.length, 1, "One authoritative migration history is required");
  const applied = new Set(namedRows.parse(source.prepare(`SELECT name FROM "${history[0].name}"`).all()).map(row => row.name));
  const revisionRow = z.object({ id: z.union([z.string(), z.number()]), revision: z.string() });
  const originalRevisions = new Map<string, Map<string | number, string>>();
  for (const table of Object.keys(counts)) {
    if (namedRows.parse(source.prepare(`PRAGMA table_info("${table}")`).all()).some(column => column.name === "revision")) {
      originalRevisions.set(table, new Map(z.array(revisionRow).parse(source.prepare(`SELECT id, revision FROM "${table}"`).all()).map(row => [row.id, row.revision])));
    }
  }
  const photoRows = z.array(z.object({ path: z.string(), data: z.string() }));
  const originalPhotos = new Map(namedRows.parse(source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='photos'").all()).length
    ? photoRows.parse(source.prepare("SELECT path, data FROM photos").all()).map(row => [row.path, row.data])
    : []);
  const schema = new DatabaseSync(":memory:");
  try {
    for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      schema.exec(sql);
      if (!applied.has(name)) source.exec(sql);
    }
    const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
    const output = await bundle.generate({ format: "esm" });
    await bundle.close();
    const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
    assert(entry?.type === "chunk", "Worker bundle present");
    worker = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "production-copy-smoke", modules: true, script: entry.code, compatibilityDate: "2026-09-08", d1Databases: ["DB"], bindings: { LOCAL_DEV: "true" } }] }));
    const db = await worker.getD1Database("DB");
    const statements = z.array(z.object({ sql: z.string() })).parse(schema.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all());
    for (const row of statements) await db.prepare(row.sql).run();
    for (const batch of batches) await db.batch(batch.split(/;\n(?=DROP|CREATE|INSERT|DELETE)|;\s*$/).filter((sql) => sql.trim()).map((sql) => db.prepare(sql)));

    // Only assets absent from the export may have independent migration IDs. Match
    // their complete data URLs, never just a digest or a recipe's current photo.
    const migratedPhotos = photoRows.parse(source.prepare("SELECT path, data FROM photos").all()).filter(row => !originalPhotos.has(row.path));
    const migratedPhotoByData = new Map(migratedPhotos.map(row => [row.data, row.path]));
    assert.equal(migratedPhotoByData.size, migratedPhotos.length, "Migrated photo data is unique");
    const photoPaths = new Map<string, string>();
    const mappedPaths = new Set<string>();
    for (const row of photoRows.parse((await db.prepare("SELECT path, data FROM photos").all()).results)) {
      if (originalPhotos.has(row.path)) {
        assert(row.data === originalPhotos.get(row.path), "Exported photo data is copied byte-for-byte at its original path");
        continue;
      }
      const expectedPath = migratedPhotoByData.get(row.data);
      assert(expectedPath !== undefined, "New photo preserves exact migrated data");
      assert(/^\/photos\/upload-[a-p]{64}\.jpg$/.test(row.path) && /^\/photos\/upload-[a-p]{64}\.jpg$/.test(expectedPath), "New migration photo IDs use the legacy-compatible namespace");
      assert(!mappedPaths.has(expectedPath), "Migrated photo mapping is one-to-one");
      mappedPaths.add(expectedPath);
      photoPaths.set(row.path, expectedPath);
    }
    assert.equal(mappedPaths.size, migratedPhotos.length, "Every migrated photo is copied");
    for (const table of Object.keys(counts)) {
      const expected = source.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all();
      const actual = (await db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()).results;
      const revisions = namedRows.parse(source.prepare(`PRAGMA table_info("${table}")`).all()).some(column => column.name === "revision")
        ? new Map(z.array(revisionRow).parse(expected).map(row => [row.id, row.revision]))
        : undefined;
      const normalized = actual.map(row => {
        const copy = { ...row };
        if (table === "photos" && typeof copy.path === "string") copy.path = photoPaths.get(copy.path) ?? copy.path;
        if (table === "recipes" && typeof copy.photo === "string") copy.photo = photoPaths.get(copy.photo) ?? copy.photo;
        if (table === "meals" && typeof copy.recipe === "string") {
          const snapshot = z.object({ photo: z.string() }).parse(JSON.parse(copy.recipe));
          const path = photoPaths.get(snapshot.photo);
          if (path !== undefined) {
            // Use the migration's JSON writer so all other snapshot values retain
            // SQLite's representation, including numbers and escaped strings.
            copy.recipe = z.object({ recipe: z.string() }).parse(source.prepare("SELECT json_set(?, '$.photo', ?) AS recipe").get(copy.recipe, path)).recipe;
          }
        }
        if (revisions) {
          const token = revisionRow.parse(row);
          const expectedRevision = revisions.get(token.id);
          assert(expectedRevision !== undefined, `${table}: revision belongs to an expected row`);
          const original = originalRevisions.get(table)?.get(token.id);
          // Photo extraction can rotate tokens that already existed in the export.
          // Exempt only rows actually changed by migration, never the entire table.
          if (expectedRevision !== original) {
            assert(/^[a-f0-9]{32}$/.test(token.revision) && /^[a-f0-9]{32}$/.test(expectedRevision), `${table}: migrated revision present`);
            assert(token.revision !== original, `${table}: migrated revision rotated`);
            copy.revision = expectedRevision;
          }
        }
        return copy;
      });
      if (table === "photos") {
        // Random IDs sort differently before normalization; compare by mapped key.
        normalized.sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
      }
      assert.equal(hash(normalized), hash(expected), `${table}: exact row/column values match after migration ID normalization`);
    }
    const response = await worker.dispatchFetch("http://localhost/api/household");
    assert.equal(response.status, 200);
    const household = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());
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
  const manifest = async (cwd: string) => z.object({ owner: z.string(), directory: z.uuid(), exportedAt: z.iso.datetime(), files: z.array(z.string()), counts: z.record(z.string(), z.number()) }).passthrough().parse(JSON.parse(await readFile(resolve(cwd, ".hearth-data/seed.json"), "utf8")));
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
