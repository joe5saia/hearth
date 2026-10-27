import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { HouseholdSchema, RecipeSchema } from "../src/domain.ts";

// Source lists and per-recipe results remain private; stdout contains only host-level counts.
const [input, output] = process.argv.slice(2);
assert(input && output, "Use: npx task recipes:import:smoke -- private-sources.json private-report.json");
assert(resolve(input) !== resolve(output), "Do not overwrite the source list");
const sources = [...new Set(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ source: Schema.String })))(JSON.parse(await readFile(input, "utf8")))
  .map(({ source }) => source).filter((source) => {
    try { return new URL(source).hostname !== "cooking.nytimes.com"; } catch { return false; }
  }))];
assert(sources.length, "Expected at least one non-NYT source URL");
const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
const generated = await bundle.generate({ format: "esm" });
await bundle.close();
const entry = generated.output.find((item) => item.type === "chunk" && item.isEntry);
assert(entry?.type === "chunk");
const worker = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: "recipe-import-smoke", modules: true, script: entry.code, compatibilityDate: "2026-09-08",
  compatibilityFlags: ["global_fetch_strictly_public"],
  d1Databases: ["DB"], bindings: { LOCAL_DEV: "true" },
}] }));
const results: { source: string; status: number; error?: string; title?: string; ingredients?: number; steps?: number; warnings?: readonly string[] }[] = [];
try {
  const db = await worker.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(sql.replace(/^--.*$/gm, "").split(/;\n+(?=CREATE|INSERT|DROP|ALTER|UPDATE|DELETE)|;\s*$/).filter((statement) => statement.trim()).map((statement) => db.prepare(statement)));
  }
  const request = (path: string, method: string, value: unknown) => worker.dispatchFetch(`http://localhost/api/${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(value),
  });
  // Serial runs avoid overloading publishers and keep persistence assertions unambiguous.
  for (const source of sources) {
    const response = await request("recipes/import", "POST", { url: source });
    const body: unknown = await response.json();
    assert.equal(response.status < 500, true, "An import must return a draft or a classified rejection, not a server error");
    assert.deepEqual(await db.prepare("SELECT count(*) AS count FROM recipes").first(), { count: 0 }, "Import wrote an unreviewed recipe");
    if (!response.ok) {
      const failure = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(body);
      results.push({ source, status: response.status, error: failure.error });
      continue;
    }
    const { recipe, warnings } = Schema.decodeUnknownSync(Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }))(body);
    assert.equal(recipe.source, source, "Original URL was not preserved");
    const saved = await request("recipes", "PUT", { ...recipe, expectedRevision: null });
    assert.equal(saved.status, 200, "The returned draft could not be saved");
    const household = Schema.decodeUnknownSync(HouseholdSchema)(await (await worker.dispatchFetch("http://localhost/api/household")).json());
    const persisted = household.recipes.find((item) => item.id === recipe.id);
    assert(persisted?.revision, "Saved recipe has a revision");
    const { revision: _revision, ...content } = persisted;
    assert.deepEqual(content, recipe, "Saved recipe did not round-trip");
    assert.equal((await request(`recipes/${recipe.id}`, "DELETE", { expectedRevision: persisted.revision })).status, 200);
    results.push({ source, status: response.status, title: recipe.title, ingredients: recipe.ingredients.length, steps: recipe.instructions.length, warnings });
  }
  assert.deepEqual(await db.prepare("SELECT count(*) AS count FROM recipes").first(), { count: 0 });
  await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
  const hosts = new Map<string, { imported: number; rejected: number }>();
  for (const result of results) {
    const host = new URL(result.source).hostname;
    const counts = hosts.get(host) ?? { imported: 0, rejected: 0 };
    if (result.status === 200) counts.imported++; else counts.rejected++;
    hosts.set(host, counts);
  }
  for (const [host, counts] of hosts) console.log(JSON.stringify({ host, ...counts }));
  console.log(JSON.stringify({ total: results.length, imported: results.filter((result) => result.status === 200).length, persistedThenRemoved: true, unreviewedWrites: 0 }));
} finally {
  await worker.dispose();
}
