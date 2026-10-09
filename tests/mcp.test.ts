import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import { Effect, Schema } from "effect";
import { updateRecipes } from "../src/recipes";
import type { GroceryItem } from "../src/domain";

let worker: Miniflare;

let assertion: string;

let token: string;

let signingKey: CryptoKey;

const telemetryPayloads: string[] = [];

const telemetryEvents: Record<string, string | number | boolean>[] = [];

const origin = "https://mcp.example.com";

const clientId = "https://client.example.com/client.json";

const redirectUri = "http://localhost:3456/callback";

const scopes = ["recipes"];

const metadata = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const request = (path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  worker.dispatchFetch(origin + path, { redirect: "manual", ...init });

async function login(scope = scopes, tamper = false, identity = assertion) {
  const verifier = "a".repeat(64);

  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scope.join(" "),
    resource: `${origin}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
  });

  const page = await request(`/authorize?${query}`, { headers: { "Cf-Access-Jwt-Assertion": identity } });
  expect(page.status, await page.clone().text()).toBe(200);
  const html = await page.text();
  expect(html).toContain('class="brand" role="img" aria-label="Hearth"');
  expect(html).toContain('viewBox="0 0 368 100"');
  expect(html).toContain('href="data:image/svg+xml,');
  expect(html).not.toContain('class="brand-dot"');
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];

  if (scope.includes("recipes")) {
    expect(html).toContain(
      "View, create, edit and delete recipes, collections, planned meals, groceries and shopping items.",
    );
    // Inert capture for browser inspection; no usable consent handle or cookies.
    await mkdir(".wrangler/mcp-smoke", { recursive: true });
    await writeFile(
      ".wrangler/mcp-smoke/consent.html",
      html
        .replace(handle, "visual-inspection-only")
        .replace('<form method="post" action="/authorize">', '<form onsubmit="return false">'),
    );
  }

  const cookie = page.headers.get("set-cookie")!.split(";")[0];
  const form = new URLSearchParams({ handle, decision: "approve" });
  scope.forEach((s) => form.append("scope", s));

  const approved = await request("/authorize", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": identity, Cookie: tamper ? "" : cookie, Origin: origin },
    body: form,
  });

  if (tamper) {
    expect(approved.status).toBe(400);

    return "";
  }

  expect(approved.status, await approved.clone().text()).toBe(302);
  const callback = new URL(approved.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("test-state");

  const response = await request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });

  expect(response.status, await response.clone().text()).toBe(200);

  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };

async function rpc(method: string, params: { name?: string; arguments?: Json } = {}, bearer = token) {
  const headers = new Headers({
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  });

  if (params.name) headers.set("Mcp-Name", params.name);

  const response = await request("/mcp", {
    method: "POST",
    headers: Object.fromEntries(headers),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: metadata } }),
  });

  expect(response.status, await response.clone().text()).toBe(200);

  return z
    .object({
      result: z.any().optional(),
      error: z.object({ code: z.number(), message: z.string() }).optional(),
    })
    .parse(await response.json());
}

const call = async (name: string, args: Json, bearer = token) => {
  const response = await rpc("tools/call", { name, arguments: args }, bearer);

  if (response.result?.structuredContent) {
    expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent);
  }

  return response.error ? { isError: true, protocolError: response.error } : response.result;
};

const success = async (name: string, args: Json) => {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();

  return result.structuredContent;
};

const draft = (title: string) => ({
  title,
  servings: 2,
  minutes: 20,
  category: "Vegetarian",
  ingredients: [
    { name: "Chickpeas", quantity: 1, unit: "can" },
    { name: "Lemon", quantity: 0.5, unit: "each" },
  ],
  instructions: ["Cook and serve."],
});

it("auto-links MCP ingredient writes and rejects invalid references atomically", async () => {
  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases) VALUES('mcp-lemon','Lemon','','',1,'each','[]')",
    )
    .run();
  const input = draft("Linked MCP");
  const originalText = "1 can chickpeas, drained and rinsed";

  const created = await call("create_recipes", {
    recipes: [{ ...input, ingredients: [{ ...input.ingredients[0], originalText }, input.ingredients[1]] }],
  });

  const recipe = created.structuredContent.recipes[0];
  expect(recipe.ingredients[1].groceryItemId).toBe("mcp-lemon");
  expect(recipe.ingredients[0].originalText).toBe(originalText);

  const updated = await call("update_recipes", {
    updates: [{ id: recipe.id, changes: { title: "Preserved MCP" } }],
  });

  expect(updated.structuredContent.recipes[0].ingredients[1].groceryItemId).toBe("mcp-lemon");
  expect(updated.structuredContent.recipes[0].ingredients[0].originalText).toBe(originalText);

  const failed = await call("create_recipes", {
    recipes: [
      draft("Atomic valid"),
      {
        ...draft("Atomic invalid"),
        ingredients: [{ name: "Lemon", quantity: 1, unit: "each", groceryItemId: "missing" }],
      },
    ],
  });

  expect(failed.isError).toBe(true);
  expect(await db.prepare("SELECT id FROM recipes WHERE title='Atomic valid'").first()).toBeNull();

  const badUpdate = await call("update_recipes", {
    updates: [
      {
        id: recipe.id,
        changes: {
          title: "Not saved",
          ingredients: [{ name: "Lemon", quantity: 1, unit: "each", groceryItemId: "missing" }],
        },
      },
    ],
  });

  expect(badUpdate.isError).toBe(true);

  const linkedUpdate = await call("update_recipes", {
    updates: [{ id: recipe.id, changes: { ingredients: [{ name: " LEMON ", quantity: 2, unit: "each" }] } }],
  });

  expect(linkedUpdate.structuredContent.recipes[0].title).toBe("Preserved MCP");
  expect(linkedUpdate.structuredContent.recipes[0].ingredients[0].groceryItemId).toBe("mcp-lemon");
  await db.prepare("DELETE FROM recipes WHERE id=?").bind(recipe.id).run();
  await db.prepare("DELETE FROM groceries WHERE id='mcp-lemon'").run();
});

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  signingKey = keys.privateKey;
  const publicKeys = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" }] };
  assertion = await new SignJWT({ email: "joe5saia@gmail.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://saiaai.cloudflareaccess.com")
    .setAudience("mcp-test")
    .setSubject("human")
    .setExpirationTime("1h")
    .sign(keys.privateKey);

  const bundle = await rolldown({
    input: "src/mcp-worker.ts",
    platform: "browser",
    external: ["cloudflare:workers", "node:async_hooks"],
    resolve: { conditionNames: ["workerd", "browser", "import", "default"] },
  });

  const output = await bundle.generate({ format: "esm" });
  await bundle.close();
  const script = output.output.find((o) => o.type === "chunk")!;

  if (script.type !== "chunk") throw new Error("Bundle missing");
  worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "mcp",
          modules: true,
          script: script.code,
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          d1Databases: ["DB"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: {
            MCP_ORIGIN: origin,
            ACCESS_AUD: "mcp-test",
            PREVIEW_CLIENT_ID: "preview-test.access",
            AXIOM_TOKEN: "disposable-mcp-ingestion",
            AXIOM_EVENTS_DATASET: "mcp-smoke-events",
            AXIOM_TRACES_DATASET: "mcp-smoke-traces",
          },
          outboundService: async (req) => {
            if (["api.axiom.co", "us-east-1.aws.edge.axiom.co"].includes(new URL(req.url).hostname)) {
              const body = await req.text();
              telemetryPayloads.push(body);

              if (new URL(req.url).pathname.startsWith("/v1/ingest/"))
                telemetryEvents.push(
                  ...Schema.decodeUnknownSync(
                    Schema.Array(
                      Schema.Record(
                        Schema.String,
                        Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
                      ),
                    ),
                  )(JSON.parse(body)),
                );

              return Response.json({ ingested: 1, failed: 0 });
            }

            if (req.url === "https://cooking.nytimes.com/recipes/1021434-coq-au-vin")
              return new Response(await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8"));

            if (req.url === "https://cooking.nytimes.com/recipes/999-redirect")
              return new Response(null, {
                status: 302,
                headers: { Location: "https://example.com/private" },
              });

            if (req.url === "https://saiaai.cloudflareaccess.com/cdn-cgi/access/certs")
              return Response.json(publicKeys);

            if (req.url === clientId)
              return Response.json({
                client_id: clientId,
                client_name: "Test client",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
              });

            return new Response("Not found", { status: 404 });
          },
        },
      ],
    }),
  );
  const db = await worker.getD1Database("DB");

  for (const file of [
    "0001_initial.sql",
    "0002_recipe_rating.sql",
    "0003_collections.sql",
    "0004_groceries.sql",
    "0006_meal_notes.sql",
  ]) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql
        .split(/;\n(?=CREATE|INSERT|DROP|ALTER)|;\s*$/)
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }

  token = await login();
}, 30000);

afterAll(async () => worker?.dispose());

it("allows OAuth grants for only the configured preview service and rejects unrelated identities", async () => {
  const sign = (claims: { sub: string; common_name?: string; email?: string }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://saiaai.cloudflareaccess.com")
      .setAudience("mcp-test")
      .setExpirationTime("1h")
      .sign(signingKey);

  const preview = await login(scopes, false, await sign({ sub: "", common_name: "preview-test.access" }));
  expect((await rpc("tools/list", {}, preview)).result.tools).toHaveLength(22);

  for (const claims of [
    { sub: "", common_name: "other.access" },
    { sub: "outsider", email: "outsider@example.com" },
  ]) {
    const response = await request("/authorize", {
      headers: { "Cf-Access-Jwt-Assertion": await sign(claims) },
    });

    expect(response.status).toBe(403);
  }
});

it("advertises CIMD and resource discovery; denies anonymous and forged tokens", async () => {
  const discovery = await request("/.well-known/oauth-authorization-server");
  expect(await discovery.json()).toMatchObject({
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["recipes"],
  });
  const resource = await request("/.well-known/oauth-protected-resource/mcp");
  expect(await resource.json()).toMatchObject({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["recipes"],
  });
  const attempts: Record<string, string>[] = [{}, { Authorization: "Bearer forged" }];

  for (const headers of attempts) {
    const response = await request("/mcp", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  }

  expect((await request("/authorize")).status).toBe(403);
  await login(scopes, true);
});

it("publishes all 22 code-mode-friendly schemas with the single recipes scope", async () => {
  const tools = (await rpc("tools/list")).result.tools;
  expect(tools.map((t: any) => t.name).sort()).toEqual([
    "add_demo_data",
    "create_recipes",
    "delete_collection",
    "delete_grocery",
    "delete_meal",
    "delete_recipe",
    "delete_shopping_extra",
    "get_recipes",
    "get_shopping_list",
    "import_recipe",
    "list_collections",
    "list_groceries",
    "list_meals",
    "match_groceries",
    "save_collection",
    "save_grocery",
    "save_meal",
    "save_shopping_extra",
    "search_recipes",
    "set_shopping_checked",
    "set_shopping_order",
    "update_recipes",
  ]);

  // The distributed skill instructions must name tools actually exposed over OAuth/MCP.
  const names = new Set(tools.map((tool: any) => tool.name));

  for (const skill of ["managing-recipes", "planning-meals", "preparing-shopping"]) {
    const instructions = await readFile(`plugins/hearth/skills/${skill}/SKILL.md`, "utf8");

    for (const match of instructions.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      expect(names.has(match[1]), `${skill} refers to unavailable tool ${match[1]}`).toBe(true);
    }
  }

  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema.type).toBe("object");
  }

  expect(tools.find((tool: any) => tool.name === "create_recipes").annotations.openWorldHint).toBe(true);
  const create = tools.find((tool: any) => tool.name === "create_recipes").inputSchema;
  expect(create.properties.recipes.items.properties.ingredients.items).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      quantity: { type: "number" },
      unit: { type: "string" },
    },
  });
});

it("decodes shared Effect defaults and trimming while rejecting nested excess fields before writes", async () => {
  const input = { ...draft("  Schema boundary  "), instructions: ["  Stir.  "] };

  const {
    recipes: [saved],
  } = await success("create_recipes", { recipes: [input] });

  expect(saved).toMatchObject({
    title: "Schema boundary",
    instructions: ["Stir."],
    description: "",
    photo: "",
    source: "",
    rating: "neutral",
  });
  const page = await success("search_recipes", {});
  expect(page.pagination).toMatchObject({ limit: 25, offset: 0 });

  for (const invalid of [
    { ...input, unexpected: true },
    { ...input, ingredients: [{ ...input.ingredients[0], unexpected: true }] },
    { ...input, ingredients: [{ ...input.ingredients[0], quantity: 0 }] },
    { ...input, ingredients: [{ ...input.ingredients[0], quantity: 1_000_001 }] },
    { ...input, ingredients: [{ ...input.ingredients[0], unit: "gallon" }] },
  ])
    expect((await call("create_recipes", { recipes: [invalid] })).isError).toBe(true);
  expect((await call("list_groceries", { unexpected: true })).isError).toBe(true);
  expect((await success("search_recipes", { query: "Schema boundary" })).pagination.total).toBe(1);
  await success("delete_recipe", { id: saved.id });
});

it("lists empty and custom collections with exact names and tracks renames and deletion", async () => {
  const db = await worker.getD1Database("DB");
  const before = (await db.prepare("SELECT id,name FROM collections ORDER BY name,id").all()).results;
  const recipesBefore = (await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results;
  // Migration-generated IDs can exceed the recipe ID input limit, even after the collection is renamed.
  const collectionId = `legacy-${"x".repeat(100)}`;
  await db
    .prepare("INSERT INTO collections(id,name) VALUES(?,'A holiday & brunch')")
    .bind(collectionId)
    .run();

  try {
    const listed = await call("list_collections", {});
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toEqual({
      collections: [{ id: collectionId, name: "A holiday & brunch" }, ...before],
    });
    expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);
    expect((await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results).toEqual(recipesBefore);
    expect((await call("list_collections", { unknown: true })).isError).toBe(true);

    const created = await call("create_recipes", {
      recipes: [
        { ...draft("Discovered collection"), category: listed.structuredContent.collections[0].name },
      ],
    });

    expect(created.isError).not.toBe(true);
    const saved = created.structuredContent.recipes[0];

    try {
      expect(saved.category).toBe("A holiday & brunch");
      expect(
        (await call("update_recipes", { updates: [{ id: saved.id, changes: { category: "special" } }] }))
          .isError,
      ).toBe(true);
      await db
        .prepare("UPDATE collections SET name='Z holiday & brunch' WHERE id=?")
        .bind(collectionId)
        .run();
      expect((await call("list_collections", {})).structuredContent.collections).toEqual([
        ...before,
        { id: collectionId, name: "Z holiday & brunch" },
      ]);
      await db.prepare("DELETE FROM collections WHERE id=?").bind(collectionId).run();
      expect((await call("list_collections", {})).structuredContent.collections).toEqual(before);
    } finally {
      await db.prepare("DELETE FROM recipes WHERE id=?").bind(saved.id).run();
    }
  } finally {
    await db.prepare("DELETE FROM collections WHERE id=?").bind(collectionId).run();
  }
});

it("requires the recipes scope even for an authenticated client", async () => {
  const unscoped = await login([]);
  const response = await request("/mcp", { headers: { Authorization: `Bearer ${unscoped}` } });
  expect(response.status).toBe(403);
  expect(response.headers.get("WWW-Authenticate")).toContain('scope="recipes"');
  expect(response.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
  token = await login();
});

it("rejects mixed valid and nonexistent collections with actionable errors and no partial writes", async () => {
  const db = await worker.getD1Database("DB");
  const before = await db.prepare("SELECT * FROM recipes ORDER BY id").all();

  const failedCreate = await call("create_recipes", {
    recipes: [draft("Must not persist"), { ...draft("Invalid collection"), category: "Missing collection" }],
  });

  expect(failedCreate.isError).toBe(true);
  expect(failedCreate.content[0].text).toContain("Choose an existing collection name");
  expect(failedCreate.content[0].text).toContain("No recipes were changed");
  expect((await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results).toEqual(before.results);
  const created = await call("create_recipes", { recipes: [draft("Membership A"), draft("Membership B")] });
  const [a, b] = created.structuredContent.recipes;

  const failedUpdate = await call("update_recipes", {
    updates: [
      { id: a.id, changes: { title: "Must not rename" } },
      { id: b.id, changes: { category: "Missing collection" } },
    ],
  });

  expect(failedUpdate.isError).toBe(true);
  expect(failedUpdate.content[0].text).toContain("Choose an existing collection name");
  expect(failedUpdate.content[0].text).toContain("No recipes were changed");
  expect((await call("get_recipes", { ids: [a.id, b.id] })).structuredContent.recipes).toEqual([a, b]);
  await db.batch([
    db.prepare("DELETE FROM recipes WHERE id=?").bind(a.id),
    db.prepare("DELETE FROM recipes WHERE id=?").bind(b.id),
  ]);
});

it("accepts custom collections and Uncollected in recipe tool inputs and outputs", async () => {
  const db = await worker.getD1Database("DB");
  await db.prepare("INSERT INTO collections(id,name) VALUES('holiday','Holiday meals')").run();

  const created = await call("create_recipes", {
    recipes: [{ ...draft("Holiday recipe"), category: "Holiday meals" }],
  });

  expect(created.isError).not.toBe(true);
  const saved = created.structuredContent.recipes[0];
  expect(saved.category).toBe("Holiday meals");
  const updated = await call("update_recipes", { updates: [{ id: saved.id, changes: { category: "" } }] });
  expect(updated.isError).not.toBe(true);
  expect(updated.structuredContent.recipes[0].category).toBe("");
  await db.prepare("DELETE FROM recipes WHERE id=?").bind(saved.id).run();
  await db.prepare("DELETE FROM collections WHERE id='holiday'").run();
});

it("creates batches, searches like the app, paginates empty/end pages, and gets requested IDs", async () => {
  const created = await call("create_recipes", {
    recipes: Array.from({ length: 25 }, (_, i) => draft(`Fixture ${String(i).padStart(2, "0")}`)),
  });

  expect(created.isError).toBeUndefined();
  expect(created.structuredContent.recipes).toHaveLength(25);
  await call("create_recipes", {
    recipes: [
      draft("Fixture 25"),
      {
        ...draft("Description only"),
        ingredients: [{ name: "Rice", quantity: 100, unit: "g" }],
        description: "Chickpeas",
      },
    ],
  });
  const first = (await call("search_recipes", { query: "CHICKPEAS" })).structuredContent;
  expect(first.recipes).toHaveLength(25);
  expect(first.pagination).toEqual({ total: 26, limit: 25, offset: 0, hasMore: true, nextOffset: 25 });
  expect(Object.keys(first.recipes[0]).sort()).toEqual(["id", "ingredients", "title"]);

  const last = (await call("search_recipes", { query: "CHICKPEAS", offset: first.pagination.nextOffset }))
    .structuredContent;

  expect(last.recipes.map((r: any) => r.title)).toEqual(["Fixture 25"]);
  expect(last.pagination.nextOffset).toBeNull();

  for (const args of [{ query: "zz-no-match" }, { query: "CHICKPEAS", offset: 99 }, { query: "%" }]) {
    const empty = (await call("search_recipes", args)).structuredContent;
    expect(empty.recipes).toEqual([]);
    expect(empty.pagination.hasMore).toBe(false);
    expect(empty.pagination.nextOffset).toBeNull();
  }

  const ids = [last.recipes[0].id, first.recipes[0].id];
  const full = (await call("get_recipes", { ids: [ids[0], "missing", ids[1]] })).structuredContent;
  expect(full.recipes.map((r: any) => r.id)).toEqual(ids);
  expect(full.missingIds).toEqual(["missing"]);
  expect(full.recipes[0]).toMatchObject({
    description: "",
    rating: "neutral",
    instructions: ["Cook and serve."],
  });
});

it("rejects the entire batch when a recipe is deleted after validation", async () => {
  const created = (await call("create_recipes", { recipes: [draft("Race A"), draft("Race B")] }))
    .structuredContent.recipes;

  const [a, b] = created;
  const db = await worker.getD1Database("DB");

  // SAFETY: updateRecipes uses only prepare and batch, both backed by real Miniflare D1.
  const racingDb = {
    prepare: db.prepare.bind(db),
    async batch(statements: Parameters<typeof db.batch>[0]) {
      await db.prepare("DELETE FROM recipes WHERE id=?").bind(b.id).run();

      return db.batch(statements);
    },
  } as D1Database;

  const update = updateRecipes(racingDb, [
    { id: a.id, changes: { minutes: 91 } },
    { id: b.id, changes: { title: "Deleted" } },
  ]);

  // Constructing an operation must not start the write or the deletion race.
  expect((await call("get_recipes", { ids: [a.id, b.id] })).structuredContent.recipes).toEqual([a, b]);

  const outcome = await Effect.runPromise(
    update.pipe(
      Effect.match({
        onSuccess: () => "unexpected success",
        onFailure: (error) => error,
      }),
    ),
  );

  expect(outcome).toMatchObject({
    _tag: "NotFound",
    message: "A recipe was deleted before the update. No recipes were updated.",
  });
  const remaining = (await call("get_recipes", { ids: [a.id, b.id] })).structuredContent;
  expect(remaining.recipes).toEqual([a]);
  expect(remaining.missingIds).toEqual([b.id]);
});

it("patches only requested fields and rejects invalid batches without partial writes", async () => {
  const created = (await call("create_recipes", { recipes: [draft("Update A"), draft("Update B")] }))
    .structuredContent.recipes;

  const [a, b] = created;

  const updated = (
    await call("update_recipes", {
      updates: [
        { id: a.id, changes: { title: "Renamed", rating: "up" } },
        { id: b.id, changes: { minutes: 37 } },
      ],
    })
  ).structuredContent.recipes;

  expect(updated[0]).toEqual({ ...a, title: "Renamed", rating: "up" });
  expect(updated[1]).toEqual({ ...b, minutes: 37 });

  for (const changes of [
    { unknown: 1 },
    { id: "replacement" },
    {},
    { ingredients: [] },
    { source: "javascript:alert(1)" },
  ]) {
    expect(
      (
        await call("update_recipes", {
          updates: [
            { id: a.id, changes: { title: "Must not persist" } },
            { id: b.id, changes },
          ],
        })
      ).isError,
    ).toBe(true);
  }

  expect(
    (
      await call("update_recipes", {
        updates: [
          { id: a.id, changes: { title: "Must not persist" } },
          { id: "missing", changes: { title: "Missing" } },
        ],
      })
    ).isError,
  ).toBe(true);
  expect((await call("get_recipes", { ids: [a.id] })).structuredContent.recipes[0].title).toBe("Renamed");

  for (const [name, args] of [
    ["get_recipes", { ids: Array.from({ length: 26 }, (_, i) => `${i}`) }],
    ["search_recipes", { limit: 26 }],
    ["create_recipes", { recipes: [] }],
    [
      "update_recipes",
      {
        updates: [
          { id: a.id, changes: { title: "x" } },
          { id: a.id, changes: { title: "y" } },
        ],
      },
    ],
  ] as const)
    expect((await call(name, args)).isError).toBe(true);
});

it("keeps storage failures distinct from actionable input errors through the household adapter", async () => {
  const db = await worker.getD1Database("DB");

  const input = {
    name: "Retry guidance product",
    url: "",
    aisle: "3",
    quantity: 400,
    unit: "g",
    aliases: [],
  };

  const before = await success("list_groceries", {});
  // A real SQLite failure exercises Worker -> API adapter -> MCP error handling.
  await db
    .prepare(
      "CREATE TRIGGER fail_mcp_grocery BEFORE INSERT ON groceries BEGIN SELECT RAISE(ABORT, 'storage detail must not leak'); END",
    )
    .run();

  try {
    const failed = await call("save_grocery", input);
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(
      "Household storage is unavailable. Read the current state before retrying a write.",
    );
    expect(await success("list_groceries", {})).toEqual(before);
  } finally {
    await db.prepare("DROP TRIGGER fail_mcp_grocery").run();
  }

  // Shared schema validation now rejects unsafe URLs before entering the operation.
  const invalidUrl = await call("save_grocery", { ...input, url: "javascript:alert(1)" });
  expect(invalidUrl.isError).toBe(true);
  expect(invalidUrl.content[0].text).toContain("HTTP(S) product URL");

  // Operation errors retain their useful correction instructions.
  for (const [name, args, message] of [
    ["delete_collection", { id: "missing-retry-collection" }, "That collection no longer exists."],
    ["save_collection", { name: "Vegetarian" }, "A collection with that name already exists."],
  ] as const) {
    const failed = await call(name, args);
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(message);
  }

  const { grocery } = await success("save_grocery", input);
  expect(
    (await success("list_groceries", {})).groceries.filter((item: any) => item.name === input.name),
  ).toEqual([grocery]);
  await success("delete_grocery", { id: grocery.id });
});

it("arranges unused catalog products before planning them through the documented route contract", async () => {
  const tools = (await rpc("tools/list")).result.tools;

  for (const name of ["list_groceries", "set_shopping_order"])
    expect(tools.find((tool: any) => tool.name === name).description).toContain(
      'JSON.stringify(["grocery", id])',
    );

  const products: GroceryItem[] = [];

  for (const [id, name] of [
    ["route-unused-a", "A unused product"],
    ['route-unused-"z', "Z unused product"],
  ]) {
    products.push(
      (
        await success("save_grocery", {
          id,
          name,
          url: "",
          aisle: "4",
          quantity: 1,
          unit: "each",
          aliases: [],
        })
      ).grocery,
    );
  }

  const range = { start: "2034-01-02", end: "2034-01-02" };
  expect((await success("list_meals", range)).meals).toEqual([]);
  expect((await success("get_shopping_list", range)).items).toEqual([]);

  const catalog = (await success("list_groceries", {})).groceries.filter((item: any) =>
    products.some((product) => product.id === item.id),
  );

  expect(catalog).toEqual(products);
  // Reverse alphabetical order within one aisle; use only discovered IDs, not planned-item keys.
  const keys = [...catalog].reverse().map((item: any) => JSON.stringify(["grocery", item.id]));
  await success("set_shopping_order", { aisles: ["4"], items: keys });
  expect((await success("get_shopping_list", range)).shoppingOrder).toEqual({ aisles: ["4"], items: keys });

  const {
    recipes: [recipe],
  } = await success("create_recipes", {
    recipes: [
      {
        ...draft("Unused route recipe"),
        ingredients: catalog.map((item: any) => ({
          name: item.name,
          quantity: 1,
          unit: "each",
          groceryItemId: item.id,
        })),
      },
    ],
  });

  const { meal } = await success("save_meal", {
    recipeId: recipe.id,
    date: range.start,
    slot: "Lunch",
    scale: 1,
    note: "",
  });

  expect((await success("get_shopping_list", range)).items).toEqual([]);
  const ordered = await success("get_shopping_list", { ...range, all: true });
  expect(ordered.items.map((item: any) => item.name)).toEqual(["Z unused product", "A unused product"]);
  expect(ordered.items.map((item: any) => item.key)).toEqual(keys);
  expect(ordered.items.every((item: any) => item.checkKey !== item.key)).toBe(true);

  await success("set_shopping_order", { aisles: [], items: [] });
  expect(
    (await success("get_shopping_list", { ...range, all: true })).items.map((item: any) => item.name),
  ).toEqual(["A unused product", "Z unused product"]);
  await success("delete_meal", { id: meal.id });
  await success("delete_recipe", { id: recipe.id });

  for (const product of products) await success("delete_grocery", { id: product.id });
});

it("manages a collection, matched products, inclusive meal plan and shopping lifecycle through RPC", async () => {
  const { collection } = await success("save_collection", { name: "MCP workflow" });
  expect((await call("save_collection", { name: "mcp WORKFLOW" })).isError).toBe(true);

  const {
    recipes: [a, b],
  } = await success("create_recipes", {
    recipes: [
      {
        ...draft("Workflow A"),
        category: collection.name,
        ingredients: [
          { name: "Workflow rice", quantity: 250, unit: "g" },
          { name: "Workflow milk", quantity: 0.25, unit: "l" },
          { name: "Workflow rice", quantity: 1, unit: "each", groceryItemId: null },
        ],
      },
      {
        ...draft("Workflow B"),
        category: collection.name,
        ingredients: [{ name: "Workflow rice", quantity: 0.25, unit: "kg" }],
      },
    ],
  });

  await success("save_collection", { id: collection.id, name: "MCP renamed" });
  expect((await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r: any) => r.category)).toEqual([
    "MCP renamed",
    "MCP renamed",
  ]);
  expect((await success("list_collections", {})).collections).toContainEqual({
    id: collection.id,
    name: "MCP renamed",
  });

  const { grocery: rice } = await success("save_grocery", {
    name: "Rice pack",
    url: "",
    aisle: "Dry",
    quantity: 400,
    unit: "g",
    aliases: ["Workflow rice"],
  });

  const { grocery: milk } = await success("save_grocery", {
    name: "Workflow milk",
    url: "",
    aisle: "Cold",
    quantity: 500,
    unit: "ml",
    aliases: [],
  });

  await success("save_grocery", { ...rice, url: "https://example.com/rice", aisle: "Pantry" });
  expect((await success("list_groceries", {})).groceries).toContainEqual({
    ...rice,
    url: "https://example.com/rice",
    aisle: "Pantry",
  });
  const unavailable = await call("match_groceries", {});
  expect(unavailable.isError).toBe(true);
  expect(unavailable.content[0].text).toContain("requires a Cloudflare deployment with an AI binding");
  expect(
    (await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r: any) => r.ingredients),
  ).toEqual([a.ingredients, b.ingredients]);
  // Local recipe saves still perform exact matching without any AI calls.
  await success("update_recipes", {
    updates: [a, b].map((r) => ({ id: r.id, changes: { ingredients: r.ingredients } })),
  });
  const linked = (await success("get_recipes", { ids: [a.id, b.id] })).recipes;
  expect(linked[0].ingredients.map((i: any) => i.groceryItemId)).toEqual([rice.id, milk.id, null]);
  expect(linked[1].ingredients[0].groceryItemId).toBe(rice.id);

  const start = "2030-05-10",
    end = "2030-05-12";

  const meals = [];

  for (const [recipeId, date, scale] of [
    [a.id, start, 1.5],
    [b.id, end, 1],
    [a.id, "2030-05-09", 10],
    [b.id, "2030-05-13", 10],
  ] as const) {
    meals.push(
      (await success("save_meal", { recipeId, date, scale, slot: "Dinner", note: "workflow" })).meal,
    );
  }

  expect((await success("list_meals", { start, end })).meals).toEqual(meals.slice(0, 2));
  const shopping = () => success("get_shopping_list", { start, end, all: true });
  expect((await success("get_shopping_list", { start, end })).items).toEqual([]);
  let list = await shopping();
  const riceItem = list.items.find((i: any) => i.grocery?.id === rice.id);
  const milkItem = list.items.find((i: any) => i.grocery?.id === milk.id);
  expect(list.items.filter((i: any) => [rice.id, milk.id].includes(i.grocery?.id))).toHaveLength(2);
  expect(riceItem).toMatchObject({
    needs: [],
    packages: 1,
    checked: true,
    warnings: [],
  });
  expect(milkItem).toMatchObject({
    needs: [],
    packages: 1,
  });
  expect(list.items.every((i: any) => i.grocery)).toBe(true);
  expect(riceItem.key).not.toBe(riceItem.checkKey);
  await success("set_shopping_checked", { key: riceItem.checkKey, checked: true });
  expect((await shopping()).items.find((i: any) => i.key === riceItem.key).checked).toBe(true);
  await success("set_shopping_checked", { key: riceItem.checkKey, checked: false });
  expect((await shopping()).items.find((i: any) => i.key === riceItem.key).checked).toBe(false);
  expect((await success("get_shopping_list", { start, end })).items.map((i: any) => i.key)).toEqual([
    riceItem.key,
  ]);
  await success("save_meal", { ...meals[0], scale: 2 });
  list = await shopping();
  expect(list.items.find((i: any) => i.key === riceItem.key)).toMatchObject({
    checked: false,
    packages: 1,
    needs: [],
  });
  expect(list.items.find((i: any) => i.key === riceItem.key).checkKey).toBe(riceItem.checkKey);
  expect(
    (await success("get_shopping_list", { start: "2031-01-01", end: "2031-01-01" })).items.map(
      (i: any) => i.key,
    ),
  ).toEqual([riceItem.key]);
  await success("set_shopping_checked", { key: riceItem.checkKey, checked: true });
  expect((await success("get_shopping_list", { start, end })).items).toEqual([]);
  const route = { aisles: ["Pantry", "Cold"], items: [riceItem.key, milkItem.key] };
  await success("set_shopping_order", route);
  expect((await shopping()).shoppingOrder).toEqual(route);
  expect((await shopping()).items.slice(0, 2).map((i: any) => i.key)).toEqual(route.items);
  await success("set_shopping_order", { aisles: [], items: [] });
  expect((await shopping()).shoppingOrder).toEqual({ aisles: [], items: [] });
  const { extra } = await success("save_shopping_extra", { name: "Paper towels", checked: 0 });
  await success("save_shopping_extra", { ...extra, name: "Kitchen towels", checked: 1 });
  expect(
    (await success("get_shopping_list", { start: "2031-01-01", end: "2031-01-01" })).extras,
  ).toContainEqual({ ...extra, name: "Kitchen towels", checked: 1 });
  await success("delete_shopping_extra", { id: extra.id });
  expect((await shopping()).extras.some((e: any) => e.id === extra.id)).toBe(false);

  const db = await worker.getD1Database("DB");

  const snapshot = async () =>
    Promise.all(
      ["recipes", "collections", "groceries", "meals", "extras", "checks", "shopping_order"].map(
        async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
      ),
    );

  const before = await snapshot();

  for (const [name, args] of [
    ["save_meal", { ...meals[0], date: "2030-02-30" }],
    ["list_meals", { start: end, end: start }],
    ["get_shopping_list", { start: "2030-02-30", end }],
    ["save_grocery", { ...rice, surprise: true }],
    ["set_shopping_order", { aisles: ["Dry", "Dry"], items: [] }],
    ["save_shopping_extra", { name: "No mutation", checked: 0, unknown: 1 }],
    ["delete_recipe", { id: a.id }],
    ["delete_grocery", { id: rice.id }],
  ] as const) {
    expect((await call(name, args)).isError, name).toBe(true);
    expect(await snapshot(), name).toEqual(before);
  }

  await success("delete_collection", { id: collection.id });
  expect((await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r: any) => r.category)).toEqual([
    "",
    "",
  ]);

  for (const meal of meals) await success("delete_meal", { id: meal.id });

  for (const recipe of linked)
    await success("update_recipes", {
      updates: [
        {
          id: recipe.id,
          changes: { ingredients: recipe.ingredients.map((i: any) => ({ ...i, groceryItemId: null })) },
        },
      ],
    });

  for (const grocery of [rice, milk]) await success("delete_grocery", { id: grocery.id });

  for (const recipe of linked) await success("delete_recipe", { id: recipe.id });
  expect((await success("get_recipes", { ids: [a.id, b.id] })).missingIds).toEqual([a.id, b.id]);
  expect((await shopping()).items).toEqual([]);
});

it("saves, lists, edits and deletes note-only meals through RPC without shopping ingredients", async () => {
  const range = { start: "2032-04-05", end: "2032-04-05" };

  const { meal } = await success("save_meal", {
    recipeId: null,
    date: range.start,
    slot: "Dinner",
    scale: 1,
    note: "Pizza",
  });

  expect((await success("list_meals", range)).meals).toEqual([meal]);
  expect((await success("get_shopping_list", range)).items).toEqual([]);
  expect((await call("save_meal", { ...meal, note: " \n\t" })).isError).toBe(true);
  const edited = { ...meal, note: "Dinner out", slot: "Lunch" };
  await success("save_meal", edited);
  expect((await success("list_meals", range)).meals).toEqual([edited]);
  await success("delete_meal", { id: meal.id });
  expect((await success("list_meals", range)).meals).toEqual([]);
});

it("imports an unsaved NYT draft, refuses unsafe URLs, and saves the reviewed draft", async () => {
  const before = (await success("search_recipes", {})).pagination.total;

  const imported = await success("import_recipe", {
    url: "https://cooking.nytimes.com/recipes/1021434-coq-au-vin",
  });

  expect(imported.recipe).toMatchObject({ title: "Coq au Vin", servings: 4, minutes: 120 });
  expect(imported.recipe).not.toHaveProperty("id");
  expect(imported.recipe.ingredients.length).toBeGreaterThan(5);
  expect(imported.recipe.instructions.length).toBeGreaterThan(1);
  expect(imported.warnings).toEqual(expect.any(Array));

  for (const url of ["https://example.com/recipes/1", "http://cooking.nytimes.com/recipes/1"])
    expect((await call("import_recipe", { url })).isError).toBe(true);
  const redirected = await call("import_recipe", { url: "https://cooking.nytimes.com/recipes/999-redirect" });
  expect(redirected.isError).toBe(true);
  expect(redirected.content[0].text).toContain("NYT couldn’t be read");
  expect((await success("search_recipes", {})).pagination.total).toBe(before);

  const {
    recipes: [saved],
  } = await success("create_recipes", { recipes: [imported.recipe] });

  expect(saved).toEqual({ ...imported.recipe, id: saved.id });
  await success("delete_recipe", { id: saved.id });
});

it("does not derive shopping needs from scaled meals and seeds only an empty household", async () => {
  const {
    recipes: [large],
  } = await success("create_recipes", {
    recipes: [
      { ...draft("Large scaled need"), ingredients: [{ name: "Bulk", quantity: 1_000_000, unit: "g" }] },
    ],
  });

  const { meal } = await success("save_meal", {
    recipeId: large.id,
    date: "2032-01-01",
    slot: "Lunch",
    scale: 2,
    note: "",
  });

  expect((await success("get_shopping_list", { start: meal.date, end: meal.date })).items).toEqual([]);
  await success("delete_meal", { id: meal.id });
  await success("delete_recipe", { id: large.id });

  // Earlier legacy scenarios deliberately leave recipes; remove them through the public tools.
  while (true) {
    const { recipes } = await success("search_recipes", {});

    if (!recipes.length) break;

    for (const recipe of recipes) await success("delete_recipe", { id: recipe.id });
  }

  // 2033-04-04 is Monday; samples are placed in the containing Monday-based week.
  await success("add_demo_data", { today: "2033-04-04" });
  const recipes = await success("search_recipes", {});
  const meals = await success("list_meals", { start: "2033-04-04", end: "2033-04-10" });
  const shopping = await success("get_shopping_list", { start: "2033-04-04", end: "2033-04-10" });
  expect(recipes.pagination.total).toBeGreaterThan(0);
  expect(meals.meals.map((meal: any) => meal.date)).toEqual([
    "2033-04-04",
    "2033-04-05",
    "2033-04-06",
    "2033-04-07",
    "2033-04-09",
  ]);
  expect(shopping.extras).toContainEqual({ id: "sample-extra", name: "Greek yogurt", checked: 0 });
  expect((await call("add_demo_data", { today: "2033-04-04" })).isError).toBe(true);
  expect(await success("search_recipes", {})).toEqual(recipes);
  expect(await success("list_meals", { start: "2033-04-04", end: "2033-04-10" })).toEqual(meals);
  expect(await success("get_shopping_list", { start: "2033-04-04", end: "2033-04-10" })).toEqual(shopping);
});

it("exports MCP tool failures even under HTTP 200 and never exports OAuth credentials or search text", async () => {
  const before = telemetryEvents.length;
  await success("search_recipes", { query: "PRIVATE-SEARCH-NEVER-EXPORT" });
  expect((await call("delete_recipe", { id: "PRIVATE-MISSING-ID-NEVER-EXPORT" })).isError).toBe(true);
  await expect
    .poll(() =>
      telemetryEvents
        .slice(before)
        .some((event) => event.event === "mcp_tool_failure" && event.operation === "delete_recipe"),
    )
    .toBe(true);

  const failure = telemetryEvents
    .slice(before)
    .find((event) => event.event === "mcp_tool_failure" && event.operation === "delete_recipe")!;

  expect(
    telemetryEvents.find(
      (event) => event.event === "server_request" && event.requestId === failure.requestId,
    ),
  ).toMatchObject({ status: 200 });
  expect(
    telemetryEvents.find((event) => event.event === "mcp_tool" && event.requestId === failure.requestId),
  ).toMatchObject({ outcome: "error" });
  const exported = telemetryPayloads.join("\n");

  for (const secret of [
    assertion,
    token,
    "joe5saia@gmail.com",
    "PRIVATE-SEARCH-NEVER-EXPORT",
    "PRIVATE-MISSING-ID-NEVER-EXPORT",
    "disposable-mcp-ingestion",
    "code_verifier",
    "SELECT ",
  ])
    expect(exported).not.toContain(secret);
  expect(exported).toContain("oauth.dispatch");
  expect(exported).toContain("mcp.delete_recipe");
});
