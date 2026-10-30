import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Option, Schema } from "effect";
import {
  RecipeSchema,
  RecipeFields,
  CollectionSchema,
  GroceryItemSchema,
  MealSchema,
  GroceryId,
  ShoppingListSchema,
  ShoppingListItemSchema,
  ShoppingOrderSchema,
  MatchReportSchema,
  type GroceryItem,
} from "../src/domain";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  OAuthTokensSchema,
  JSONRPCResponseSchema,
} from "@modelcontextprotocol/core";

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
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];

  if (handle === undefined) throw new Error("Consent handle missing");

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

  const setCookie = page.headers.get("set-cookie");

  if (setCookie === null) throw new Error("Consent cookie missing");
  const cookie = setCookie.split(";")[0];
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
  const location = approved.headers.get("location");

  if (location === null) throw new Error("Consent redirect missing");
  const callback = new URL(location);
  expect(callback.searchParams.get("state")).toBe("test-state");
  const code = callback.searchParams.get("code");

  if (code === null) throw new Error("Authorization code missing");

  const response = await request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });

  expect(response.status, await response.clone().text()).toBe(200);

  return OAuthTokensSchema.parse(await response.json()).access_token;
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

  return JSONRPCResponseSchema.parse(await response.json());
}

const recipesOutput = Schema.Struct({ recipes: Schema.Array(RecipeSchema) });

const okOutput = Schema.Struct({ ok: Schema.Literal(true) });

// Decode Worker JSON using the domain owners; only transport envelopes live here.
const outputs = {
  create_recipes: recipesOutput,
  update_recipes: Schema.Struct({ ...recipesOutput.fields, missingIds: Schema.Array(Schema.String) }),
  get_recipes: Schema.Struct({ ...recipesOutput.fields, missingIds: Schema.Array(Schema.String) }),
  search_recipes: Schema.Struct({
    recipes: Schema.Array(
      Schema.Struct({
        id: RecipeSchema.fields.id,
        revision: Schema.NonEmptyString,
        title: RecipeFields.fields.title,
        ingredients: RecipeFields.fields.ingredients,
      }),
    ),
    pagination: Schema.Struct({
      total: Schema.Number,
      limit: Schema.Number,
      offset: Schema.Number,
      hasMore: Schema.Boolean,
      nextOffset: Schema.NullOr(Schema.Number),
    }),
  }),
  list_collections: Schema.Struct({ collections: Schema.Array(CollectionSchema) }),
  save_collection: Schema.Struct({ collection: CollectionSchema }),
  list_groceries: Schema.Struct({ groceries: Schema.Array(GroceryItemSchema) }),
  save_grocery: Schema.Struct({ grocery: GroceryItemSchema }),
  list_meals: Schema.Struct({ meals: Schema.Array(MealSchema) }),
  save_meal: Schema.Struct({ meal: MealSchema }),
  list_shopping_lists: Schema.Struct({
    lists: Schema.Array(
      Schema.Struct({
        ...ShoppingListSchema.fields,
        revision: Schema.String,
        items: Schema.Number,
        checked: Schema.Number,
      }),
    ),
  }),
  create_shopping_list: Schema.Struct({ list: ShoppingListSchema }),
  update_shopping_list: Schema.Struct({ list: ShoppingListSchema }),
  get_shopping_list: Schema.Struct({
    list: ShoppingListSchema,
    items: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        groceryId: GroceryId,
        name: Schema.String,
        grocery: GroceryItemSchema,
        checked: Schema.Boolean,
        packages: ShoppingListItemSchema.fields.packages,
        sources: ShoppingListItemSchema.fields.sources,
        addedAt: Schema.String,
        checkedAt: Schema.NullOr(Schema.String),
      }),
    ),
    shoppingOrder: ShoppingOrderSchema,
  }),
  add_shopping_items: Schema.Struct({
    added: Schema.Array(GroceryId),
    updated: Schema.Array(GroceryId),
    unchanged: Schema.Array(GroceryId),
    conflicts: Schema.Array(
      Schema.Struct({ groceryId: GroceryId, checked: Schema.Boolean, packages: Schema.Number }),
    ),
  }),
  set_shopping_item: okOutput,
  remove_shopping_items: Schema.Struct({ removed: Schema.Number }),
  import_recipe: Schema.Struct({ recipe: RecipeFields, warnings: Schema.Array(Schema.String) }),
  match_groceries: Schema.Struct({ ok: Schema.Literal(true), report: MatchReportSchema }),
  delete_recipe: okOutput,
  delete_collection: okOutput,
  delete_grocery: okOutput,
  delete_meal: okOutput,
  delete_shopping_list: okOutput,
  set_shopping_order: Schema.Struct({ ...okOutput.fields, revision: Schema.String }),
  add_demo_data: okOutput,
};

async function listTools(bearer = token) {
  const response = await rpc("tools/list", {}, bearer);

  if (!("result" in response)) throw new Error("Tool discovery returned a protocol error");

  return ListToolsResultSchema.parse(response.result).tools;
}

const call = async <Name extends keyof typeof outputs>(name: Name, args: Json, bearer = token) => {
  // Fresh-write convenience for existing scenarios only. Explicit guards are never replaced.
  const tables: Partial<Record<keyof typeof outputs, string>> = {
    save_collection: "collections",
    delete_collection: "collections",
    save_grocery: "groceries",
    delete_grocery: "groceries",
    save_meal: "meals",
    delete_meal: "meals",
    delete_shopping_list: "shopping_lists",
    delete_recipe: "recipes",
    set_shopping_order: "shopping_order",
  };

  const input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(args);
  const db = await worker.getD1Database("DB");

  const revisionFor = async (table: string, id: string | number | undefined) => {
    const row =
      id === undefined ? null : await db.prepare(`SELECT revision FROM ${table} WHERE id=?`).bind(id).first();

    return row ? Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.String }))(row).revision : null;
  };

  const table = tables[name];

  if (table && !("expectedRevision" in input)) {
    const id =
      name === "set_shopping_order"
        ? 1
        : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(input.id));

    args = {
      ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(args),
      expectedRevision: (await revisionFor(table, id)) ?? (name.startsWith("delete_") ? "missing" : null),
    };
  } else if (name === "update_recipes" && Array.isArray(input.updates)) {
    const updates = await Promise.all(
      input.updates.map(async (value) => {
        const update = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value);

        return "expectedRevision" in update
          ? update
          : {
              ...update,
              expectedRevision:
                (await revisionFor(
                  "recipes",
                  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(update.id)),
                )) ?? "missing",
            };
      }),
    );

    args = { updates };
  }

  const response = await rpc("tools/call", { name, arguments: args }, bearer);

  const result =
    "result" in response
      ? CallToolResultSchema.parse(response.result)
      : { isError: true, protocolError: response.error, content: [], structuredContent: undefined };

  const content = result.content.map((block) => {
    if (block.type !== "text") throw new Error("Expected text tool content");

    return block;
  });

  if (result.structuredContent) {
    expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
  }

  return {
    ...result,
    content,
    // Failure responses deliberately lack data; decode only when a scenario reads successful data.
    get structuredContent() {
      return Schema.decodeUnknownSync(Schema.make<(typeof outputs)[Name]>(outputs[name].ast), {
        onExcessProperty: "error",
      })(result.structuredContent);
    },
  };
};

const success = async <Name extends keyof typeof outputs>(name: Name, args: Json) => {
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
  const script = output.output.find((o) => o.type === "chunk");

  if (!script || script.type !== "chunk") throw new Error("Bundle missing");
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

            if (new URL(req.url).hostname === "cloudflare-dns.com")
              return Response.json({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1" }] });

            if (
              req.url === "https://cooking.nytimes.com/recipes/1021434-coq-au-vin" ||
              req.url === "https://recipes.example.com/coq-au-vin"
            )
              return new Response(await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8"));

            if (req.url === "https://cooking.nytimes.com/recipes/999-redirect")
              return new Response(null, {
                status: 302,
                headers: { Location: "https://127.0.0.1/private" },
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
    "0005_ingredient_matching.sql",
    "0006_meal_notes.sql",
    "0007_shopping_membership.sql",
    "0008_grocery_delete_unlink.sql",
    "0010_shopping_packages.sql",
    "0011_meal_recipes.sql",
    "0012_entity_revisions.sql",
    "0013_photos.sql",
    "0014_detached_meals.sql",
    "0015_shopping_lists.sql",
  ]) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql
        .replace(/^--.*$/gm, "")
        .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
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
  expect(await listTools(preview)).toHaveLength(26);

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

it("publishes all 26 code-mode-friendly schemas with the single recipes scope", async () => {
  const tools = await listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "add_demo_data",
    "add_shopping_items",
    "create_recipes",
    "create_shopping_list",
    "delete_collection",
    "delete_grocery",
    "delete_meal",
    "delete_recipe",
    "delete_shopping_list",
    "get_recipes",
    "get_shopping_list",
    "import_recipe",
    "list_collections",
    "list_groceries",
    "list_meals",
    "list_shopping_lists",
    "match_groceries",
    "remove_shopping_items",
    "save_collection",
    "save_grocery",
    "save_meal",
    "search_recipes",
    "set_shopping_item",
    "set_shopping_order",
    "update_recipes",
    "update_shopping_list",
  ]);

  // The distributed skill instructions must name tools actually exposed over OAuth/MCP.
  const names = new Set(tools.map((tool) => tool.name));

  for (const skill of ["managing-recipes", "planning-meals", "preparing-shopping"]) {
    const instructions = await readFile(`plugins/hearth/skills/${skill}/SKILL.md`, "utf8");

    for (const match of instructions.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      expect(names.has(match[1]), `${skill} refers to unavailable tool ${match[1]}`).toBe(true);
    }
  }

  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema?.type).toBe("object");
  }

  const saveMeal = tools.find((tool) => tool.name === "save_meal");
  const listMeals = tools.find((tool) => tool.name === "list_meals");
  expect(saveMeal?.inputSchema).toHaveProperty("properties.recipe");
  expect(saveMeal?.inputSchema.required).not.toContain("recipe");
  expect(saveMeal?.outputSchema).toHaveProperty("properties.meal.properties.recipe");
  expect(listMeals?.outputSchema).toHaveProperty("properties.meals.items.properties.recipe");
  expect(saveMeal?.description).toContain("never the source or another meal");
  expect(listMeals?.description).toContain("independent editable recipe snapshot");

  const tool = (name: string) => {
    const found = tools.find((entry) => entry.name === name);

    if (!found) throw new Error(`${name} tool missing`);

    return found;
  };

  expect(tool("list_shopping_lists").annotations?.readOnlyHint).toBe(true);
  expect(tool("get_shopping_list").annotations?.readOnlyHint).toBe(true);
  expect(tool("get_shopping_list").inputSchema.required).toEqual(["listId"]);
  expect(tool("get_shopping_list").outputSchema).toHaveProperty(
    "properties.items.items.properties.sources.items.properties.mealId",
  );
  expect(tool("list_shopping_lists").outputSchema).toHaveProperty(
    "properties.lists.items.properties.checked",
  );
  expect(tool("create_shopping_list").inputSchema.required).toEqual(["date"]);
  expect(tool("create_shopping_list").annotations?.idempotentHint).toBe(false);
  expect(tool("add_shopping_items").inputSchema).toHaveProperty(
    "properties.items.items.properties.checked.type",
    "boolean",
  );
  expect(tool("add_shopping_items").outputSchema).toHaveProperty(
    "properties.conflicts.items.properties.packages",
  );
  expect(tool("add_shopping_items").description).toContain("replace:true");
  expect(tool("add_shopping_items").description).toContain("conflicts");
  expect(tool("remove_shopping_items").description).toContain("already have it");
  expect(tool("set_shopping_item").inputSchema.required).toEqual(["listId", "groceryId"]);
  expect(tool("set_shopping_order").description).toContain("item.key strings from get_shopping_list");

  const create = tools.find((tool) => tool.name === "create_recipes");

  if (!create) throw new Error("create_recipes tool missing");
  expect(create.annotations?.openWorldHint).toBe(true);
  expect(create.inputSchema).toMatchObject({
    properties: {
      recipes: {
        items: {
          properties: {
            ingredients: {
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  quantity: { type: "number" },
                  unit: { type: "string" },
                },
              },
            },
          },
        },
      },
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
  const before = (await db.prepare("SELECT * FROM collections ORDER BY name,id").all()).results;
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
      collections: [
        { id: collectionId, name: "A holiday & brunch", revision: expect.any(String) },
        ...before,
      ],
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
        { id: collectionId, name: "Z holiday & brunch", revision: expect.any(String) },
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
  expect(Object.keys(first.recipes[0]).sort()).toEqual(["id", "ingredients", "revision", "title"]);
  expect(first.recipes[0].revision).toBe(created.structuredContent.recipes[0].revision);

  const last = (await call("search_recipes", { query: "CHICKPEAS", offset: first.pagination.nextOffset }))
    .structuredContent;

  expect(last.recipes.map((r) => r.title)).toEqual(["Fixture 25"]);
  expect(last.pagination.nextOffset).toBeNull();

  for (const args of [{ query: "zz-no-match" }, { query: "CHICKPEAS", offset: 99 }, { query: "%" }]) {
    const empty = (await call("search_recipes", args)).structuredContent;
    expect(empty.recipes).toEqual([]);
    expect(empty.pagination.hasMore).toBe(false);
    expect(empty.pagination.nextOffset).toBeNull();
  }

  const ids = [last.recipes[0].id, first.recipes[0].id];
  const full = (await call("get_recipes", { ids: [ids[0], "missing", ids[1]] })).structuredContent;
  expect(full.recipes.map((r) => r.id)).toEqual(ids);
  expect(full.missingIds).toEqual(["missing"]);
  expect(full.recipes[0]).toMatchObject({
    description: "",
    rating: "neutral",
    instructions: ["Cook and serve."],
  });
});

it("rejects stale and deleted recipe batches atomically through RPC and advertises required guards", async () => {
  const created = (await call("create_recipes", { recipes: [draft("Race A"), draft("Race B")] }))
    .structuredContent.recipes;

  const [a, b] = created;
  const db = await worker.getD1Database("DB");

  if (!a.revision || !b.revision) throw new Error("Missing persisted revisions");

  const updates = [
    { id: a.id, expectedRevision: a.revision, changes: { minutes: 91 } },
    { id: b.id, expectedRevision: b.revision, changes: { title: "Must not persist" } },
  ];

  // Real old-worker SQL rotates the token without consulting the new contract.
  await db.prepare("UPDATE recipes SET description='Concurrent description' WHERE id=?").bind(b.id).run();
  const before = (await call("get_recipes", { ids: [a.id, b.id] })).structuredContent.recipes;
  const failed = await call("update_recipes", { updates });
  expect(failed.isError).toBe(true);
  expect((await call("get_recipes", { ids: [a.id, b.id] })).structuredContent.recipes).toEqual(before);
  expect((await call("delete_recipe", { id: b.id, expectedRevision: b.revision })).isError).toBe(true);
  await db.prepare("DELETE FROM recipes WHERE id=?").bind(b.id).run();
  expect((await call("update_recipes", { updates })).isError).toBe(true);
  const remaining = (await call("get_recipes", { ids: [a.id, b.id] })).structuredContent;
  expect(remaining.recipes).toEqual([a]);
  expect(remaining.missingIds).toEqual([b.id]);

  const unguarded = await rpc("tools/call", {
    name: "update_recipes",
    arguments: { updates: [{ id: a.id, changes: { minutes: 99 } }] },
  });

  if ("result" in unguarded) expect(CallToolResultSchema.parse(unguarded.result).isError).toBe(true);
  else expect(unguarded.error).toBeDefined();
  expect((await call("get_recipes", { ids: [a.id] })).structuredContent.recipes).toEqual([a]);
  const tools = await listTools();

  for (const name of [
    "save_collection",
    "save_grocery",
    "save_meal",
    "update_shopping_list",
    "set_shopping_order",
    "delete_recipe",
    "delete_grocery",
    "delete_collection",
    "delete_meal",
    "delete_shopping_list",
  ])
    expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain("expectedRevision");
});

it("saves a maximum-size recipe batch exceeding 2 MB while preserving omitted fields and stale guards", async () => {
  const before = (
    await call("create_recipes", {
      recipes: Array.from({ length: 25 }, (_, index) => draft(`Large batch ${index}`)),
    })
  ).structuredContent.recipes;

  const updates = before.map((recipe, index) => ({
    id: recipe.id,
    expectedRevision: recipe.revision,
    changes: {
      instructions:
        index < 2
          ? Array.from({ length: 100 }, (_, step) => `${index}:${step}:`.padEnd(10_000, "x"))
          : [`Serve recipe ${index}.`],
    },
  }));

  expect(Buffer.byteLength(JSON.stringify(updates))).toBeGreaterThan(2_000_000);
  const result = await call("update_recipes", { updates });
  expect(result.isError).toBeUndefined();
  const saved = result.structuredContent.recipes;
  expect(saved).toEqual(
    before.map((recipe, index) => ({
      ...recipe,
      instructions: updates[index].changes.instructions,
      revision: expect.any(String),
    })),
  );

  for (const [index, recipe] of saved.entries()) expect(recipe.revision).not.toBe(before[index].revision);

  // A single stale member still rejects the entire large batch.
  const stale = updates.map((update, index) => ({
    ...update,
    expectedRevision: index === 24 ? update.expectedRevision : saved[index].revision,
    changes: { ...update.changes, minutes: 83 },
  }));

  expect((await call("update_recipes", { updates: stale })).isError).toBe(true);
  expect(
    (await call("get_recipes", { ids: before.map((recipe) => recipe.id) })).structuredContent.recipes,
  ).toEqual(saved);

  for (const recipe of saved)
    await call("delete_recipe", { id: recipe.id, expectedRevision: recipe.revision });
});

it("rolls back recipe batch fields and revisions when SQLite rejects a later row", async () => {
  const before = (await call("create_recipes", { recipes: [draft("Atomic A"), draft("Atomic B")] }))
    .structuredContent.recipes;

  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "CREATE TRIGGER fail_recipe_batch BEFORE UPDATE OF title ON recipes WHEN NEW.title='Reject batch' BEGIN SELECT RAISE(ABORT, 'private storage detail'); END",
    )
    .run();

  try {
    const failed = await call("update_recipes", {
      updates: before.map((recipe, index) => ({
        id: recipe.id,
        expectedRevision: recipe.revision,
        changes: { title: index ? "Reject batch" : "Must roll back" },
      })),
    });

    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(
      "Household storage is unavailable. Read the current state before retrying a write.",
    );
    expect(
      (await call("get_recipes", { ids: before.map((recipe) => recipe.id) })).structuredContent.recipes,
    ).toEqual(before);
  } finally {
    await db.prepare("DROP TRIGGER fail_recipe_batch").run();
  }
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

  expect(updated[0]).toEqual({ ...a, title: "Renamed", rating: "up", revision: expect.any(String) });
  expect(updated[1]).toEqual({ ...b, minutes: 37, revision: expect.any(String) });
  expect(updated[0].revision).not.toBe(a.revision);
  expect(updated[1].revision).not.toBe(b.revision);

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
    [
      "delete_collection",
      { id: "missing-retry-collection" },
      "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
    ],
    [
      "save_collection",
      { name: "Vegetarian" },
      "This collection changed, no longer exists, or its name is already in use. Reload before saving.",
    ],
  ] as const) {
    const failed = await call(name, args);
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(message);
  }

  const { grocery } = await success("save_grocery", input);
  expect((await success("list_groceries", {})).groceries.filter((item) => item.name === input.name)).toEqual([
    grocery,
  ]);
  await success("delete_grocery", { id: grocery.id });
});

it("arranges unused catalog products before planning them through the documented route contract", async () => {
  const tools = await listTools();

  for (const name of ["list_groceries", "set_shopping_order"])
    expect(tools.find((tool) => tool.name === name)?.description).toContain(
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
  const { list } = await success("create_shopping_list", { date: range.start });
  expect((await success("get_shopping_list", { listId: list.id })).items).toEqual([]);

  const catalog = (await success("list_groceries", {})).groceries.filter((item) =>
    products.some((product) => product.id === item.id),
  );

  expect(catalog).toEqual(products);
  // Reverse alphabetical order within one aisle; use only discovered IDs, not planned-item keys.
  const keys = [...catalog].reverse().map((item) => JSON.stringify(["grocery", item.id]));
  await success("set_shopping_order", { aisles: ["4"], items: keys });
  expect((await success("get_shopping_list", { listId: list.id })).shoppingOrder).toEqual({
    aisles: ["4"],
    items: keys,
    revision: expect.any(String),
  });

  const {
    recipes: [recipe],
  } = await success("create_recipes", {
    recipes: [
      {
        ...draft("Unused route recipe"),
        ingredients: catalog.map((item) => ({
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

  // Planning a meal never adds items; the agent adds them to the chosen list explicitly.
  expect((await success("get_shopping_list", { listId: list.id })).items).toEqual([]);
  await success("add_shopping_items", {
    listId: list.id,
    items: catalog.map((item) => ({ groceryId: item.id })),
  });
  const ordered = await success("get_shopping_list", { listId: list.id });
  expect(ordered.items.map((item) => item.name)).toEqual(["Z unused product", "A unused product"]);
  expect(ordered.items.map((item) => item.key)).toEqual(keys);
  expect(ordered.items.every((item) => item.groceryId !== item.key)).toBe(true);

  await success("set_shopping_order", { aisles: [], items: [] });
  expect((await success("get_shopping_list", { listId: list.id })).items.map((item) => item.name)).toEqual([
    "A unused product",
    "Z unused product",
  ]);
  await success("delete_shopping_list", { id: list.id });
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
  expect((await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r) => r.category)).toEqual([
    "MCP renamed",
    "MCP renamed",
  ]);
  expect((await success("list_collections", {})).collections).toContainEqual({
    id: collection.id,
    name: "MCP renamed",
    revision: expect.any(String),
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
    revision: expect.any(String),
  });
  const unavailable = await call("match_groceries", {});
  expect(unavailable.isError).toBe(true);
  expect(unavailable.content[0].text).toContain("requires a Cloudflare deployment with an AI binding");
  expect((await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r) => r.ingredients)).toEqual([
    a.ingredients,
    b.ingredients,
  ]);
  // Local recipe saves still perform exact matching without any AI calls.
  await success("update_recipes", {
    updates: [a, b].map((r) => ({ id: r.id, changes: { ingredients: r.ingredients } })),
  });
  const linked = (await success("get_recipes", { ids: [a.id, b.id] })).recipes;
  expect(linked[0].ingredients.map((i) => i.groceryItemId)).toEqual([rice.id, milk.id, null]);
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
  const { list } = await success("create_shopping_list", { date: start, label: "Workflow" });
  const shopping = () => success("get_shopping_list", { listId: list.id });
  expect((await shopping()).items).toEqual([]);
  const riceKey = JSON.stringify(["grocery", rice.id]);
  const milkKey = JSON.stringify(["grocery", milk.id]);

  const riceSources = [
    { title: "Workflow A", mealId: meals[0].id, date: meals[0].date },
    { title: "Workflow B", mealId: meals[1].id, date: meals[1].date },
  ];

  expect(
    await success("add_shopping_items", {
      listId: list.id,
      items: [
        { groceryId: rice.id, sources: riceSources },
        { groceryId: milk.id, sources: [riceSources[0]] },
      ],
    }),
  ).toEqual({ added: [rice.id, milk.id], updated: [], unchanged: [], conflicts: [] });
  let current = await shopping();
  // Default route: named aisles alphabetically (Cold before Pantry).
  expect(current.items.map((i) => i.key)).toEqual([milkKey, riceKey]);
  expect(current.items[1]).toEqual({
    key: riceKey,
    groceryId: rice.id,
    name: "Rice pack",
    grocery: { ...rice, url: "https://example.com/rice", aisle: "Pantry", revision: expect.any(String) },
    checked: false,
    packages: 1,
    sources: riceSources,
    addedAt: expect.any(String),
    checkedAt: null,
  });
  await success("set_shopping_item", { listId: list.id, groceryId: rice.id, packages: 3 });
  await success("set_shopping_item", { listId: list.id, groceryId: rice.id, checked: true });
  await success("save_meal", { ...meals[0], scale: 2 });
  // Meal edits never rewrite list rows.
  current = await shopping();
  expect(current.items.find((i) => i.key === riceKey)).toMatchObject({
    checked: true,
    packages: 3,
    checkedAt: expect.any(String),
    sources: riceSources,
  });
  const route = { aisles: ["Pantry", "Cold"], items: [riceKey, milkKey] };
  await success("set_shopping_order", route);
  expect((await shopping()).shoppingOrder).toEqual({ ...route, revision: expect.any(String) });
  expect((await shopping()).items.map((i) => i.key)).toEqual(route.items);
  await success("set_shopping_order", { aisles: [], items: [] });
  expect((await shopping()).shoppingOrder).toEqual({ aisles: [], items: [], revision: expect.any(String) });

  const db = await worker.getD1Database("DB");

  const snapshot = async () =>
    Promise.all(
      [
        "recipes",
        "collections",
        "groceries",
        "meals",
        "shopping_lists",
        "shopping_list_items",
        "shopping_order",
      ].map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results),
    );

  const before = await snapshot();

  for (const [name, args] of [
    ["save_meal", { ...meals[0], date: "2030-02-30" }],
    ["list_meals", { start: end, end: start }],
    ["get_shopping_list", { listId: list.id, all: true }],
    ["create_shopping_list", { date: "2030-02-30" }],
    ["save_grocery", { ...rice, surprise: true }],
    ["set_shopping_order", { aisles: ["Dry", "Dry"], items: [] }],
    ["add_shopping_items", { listId: list.id, items: [{ groceryId: milk.id, packages: 2, unknown: 1 }] }],
    ["delete_recipe", { id: a.id, expectedRevision: "stale" }],
    ["delete_grocery", { id: "missing-grocery" }],
  ] as const) {
    expect((await call(name, args)).isError, name).toBe(true);
    expect(await snapshot(), name).toEqual(before);
  }

  await success("delete_collection", { id: collection.id });
  expect((await success("get_recipes", { ids: [a.id, b.id] })).recipes.map((r) => r.category)).toEqual([
    "",
    "",
  ]);

  for (const meal of meals) await success("delete_meal", { id: meal.id });

  for (const grocery of [rice, milk]) await success("delete_grocery", { id: grocery.id });
  const unlinked = (await success("get_recipes", { ids: linked.map((recipe) => recipe.id) })).recipes;
  expect(unlinked).toEqual(
    linked.map((recipe) => ({
      ...recipe,
      category: "",
      revision: expect.any(String),
      ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, groceryItemId: null })),
    })),
  );

  // Deleting a catalog grocery removes it from every list.
  expect((await shopping()).items).toEqual([]);
  const lateCheck = await call("set_shopping_item", { listId: list.id, groceryId: rice.id, checked: false });
  expect(lateCheck.isError).toBe(true);
  expect(lateCheck.content).toEqual([
    { type: "text", text: "That grocery is no longer on this list. Refresh the list before changing it." },
  ]);
  const lateAdd = await call("add_shopping_items", { listId: list.id, items: [{ groceryId: rice.id }] });
  expect(lateAdd.isError).toBe(true);
  expect(lateAdd.content[0].text).toBe(
    "Some of those groceries no longer exist. Refresh the groceries before adding them; no items were added.",
  );
  await success("save_grocery", rice);
  // Recreating a product does not restore old list membership.
  expect((await shopping()).items).toEqual([]);
  await success("add_shopping_items", { listId: list.id, items: [{ groceryId: rice.id }] });
  expect((await shopping()).items.map((i) => i.groceryId)).toEqual([rice.id]);
  await success("delete_grocery", { id: rice.id });

  for (const recipe of linked) await success("delete_recipe", { id: recipe.id });
  expect((await success("get_recipes", { ids: [a.id, b.id] })).missingIds).toEqual([a.id, b.id]);
  expect((await shopping()).items).toEqual([]);
  await success("delete_shopping_list", { id: list.id });
});

it("manages dated shopping lists by ID: sources, conflicts, replace, checks, removal and guards", async () => {
  const db = await worker.getD1Database("DB");

  const product = async (name: string, aisle: string) =>
    (await success("save_grocery", { name, url: "", aisle, quantity: 1, unit: "each", aliases: [] })).grocery;

  const oats = await product("Lifecycle oats", "Dry");
  const milk = await product("Lifecycle milk", "Cold");
  const eggs = await product("Lifecycle eggs", "Cold");
  const date = "2036-03-01";
  const { list: weekly } = await success("create_shopping_list", { date });
  const { list: topUp } = await success("create_shopping_list", { date, label: "  Top-up  " });
  expect(weekly).toEqual({ id: expect.any(String), date, label: "", revision: expect.any(String) });
  expect(topUp).toEqual({ id: expect.any(String), date, label: "Top-up", revision: expect.any(String) });
  expect(weekly.id).not.toBe(topUp.id);

  const summary = async () =>
    (await success("list_shopping_lists", {})).lists.filter((list) =>
      [weekly.id, topUp.id].includes(list.id),
    );

  // Same-date lists are ordered by ID.
  expect(await summary()).toEqual(
    [weekly, topUp]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((list) => ({ ...list, revision: list.revision, items: 0, checked: 0 })),
  );

  const porridge = { title: "Lifecycle porridge", mealId: "lifecycle-meal", date };
  expect(
    await success("add_shopping_items", {
      listId: weekly.id,
      items: [
        { groceryId: oats.id, packages: 2, sources: [porridge] },
        { groceryId: milk.id },
        { groceryId: eggs.id, checked: true },
      ],
    }),
  ).toEqual({ added: [oats.id, milk.id, eggs.id], updated: [], unchanged: [], conflicts: [] });
  expect(
    await success("add_shopping_items", { listId: topUp.id, items: [{ groceryId: milk.id, packages: 3 }] }),
  ).toEqual({ added: [milk.id], updated: [], unchanged: [], conflicts: [] });

  const read = async (listId: string) => {
    const result = await success("get_shopping_list", { listId });

    return { ...result, byId: new Map(result.items.map((item) => [item.groceryId, item])) };
  };

  let current = await read(weekly.id);
  expect(current.list).toEqual(weekly);
  // Default route: Cold before Dry, then name.
  expect(current.items.map((item) => item.groceryId)).toEqual([eggs.id, milk.id, oats.id]);
  expect(current.byId.get(oats.id)).toEqual({
    key: JSON.stringify(["grocery", oats.id]),
    groceryId: oats.id,
    name: oats.name,
    grocery: oats,
    checked: false,
    packages: 2,
    sources: [porridge],
    addedAt: expect.any(String),
    checkedAt: null,
  });
  expect(current.byId.get(milk.id)).toMatchObject({ checked: false, packages: 1, sources: [] });
  expect(current.byId.get(eggs.id)).toMatchObject({
    checked: true,
    packages: 1,
    checkedAt: expect.any(String),
  });
  expect((await read(topUp.id)).items.map((item) => [item.groceryId, item.packages])).toEqual([[milk.id, 3]]);
  expect((await summary()).find((list) => list.id === weekly.id)).toMatchObject({ items: 3, checked: 1 });

  // Matching unchecked rows merge sources; checked or differently counted rows are reported, not changed.
  const granola = { title: "Lifecycle granola" };
  expect(
    await success("add_shopping_items", {
      listId: weekly.id,
      items: [
        { groceryId: oats.id, sources: [granola, porridge] },
        { groceryId: milk.id, packages: 4, sources: [granola] },
        { groceryId: eggs.id },
      ],
    }),
  ).toEqual({
    added: [],
    updated: [],
    unchanged: [oats.id],
    conflicts: [
      { groceryId: milk.id, checked: false, packages: 1 },
      { groceryId: eggs.id, checked: true, packages: 1 },
    ],
  });
  current = await read(weekly.id);
  expect(current.byId.get(oats.id)?.sources).toHaveLength(2);
  expect(current.byId.get(oats.id)?.sources).toEqual(expect.arrayContaining([porridge, granola]));
  expect(current.byId.get(oats.id)?.packages).toBe(2);
  expect(current.byId.get(milk.id)).toMatchObject({ packages: 1, sources: [] });
  expect(current.byId.get(eggs.id)).toMatchObject({ checked: true });

  // The user confirmed the conflicts: replace applies them and merges sources.
  expect(
    await success("add_shopping_items", {
      listId: weekly.id,
      items: [
        { groceryId: milk.id, packages: 4, sources: [granola], replace: true },
        { groceryId: eggs.id, checked: false, replace: true },
      ],
    }),
  ).toEqual({ added: [], updated: [milk.id, eggs.id], unchanged: [], conflicts: [] });
  current = await read(weekly.id);
  expect(current.byId.get(milk.id)).toMatchObject({ checked: false, packages: 4, sources: [granola] });
  expect(current.byId.get(eggs.id)).toMatchObject({ checked: false, packages: 1, checkedAt: null });
  expect((await read(topUp.id)).byId.get(milk.id)?.packages).toBe(3);

  // Field-scoped item changes.
  await success("set_shopping_item", { listId: weekly.id, groceryId: oats.id, checked: true });
  expect((await read(weekly.id)).byId.get(oats.id)).toMatchObject({
    checked: true,
    packages: 2,
    checkedAt: expect.any(String),
  });
  await success("set_shopping_item", { listId: weekly.id, groceryId: oats.id, packages: 5 });
  expect((await read(weekly.id)).byId.get(oats.id)).toMatchObject({ checked: true, packages: 5 });
  await success("set_shopping_item", { listId: weekly.id, groceryId: oats.id, checked: false });
  expect((await read(weekly.id)).byId.get(oats.id)).toMatchObject({
    checked: false,
    packages: 5,
    checkedAt: null,
  });
  await success("set_shopping_item", { listId: weekly.id, groceryId: eggs.id, checked: true });
  expect((await summary()).find((list) => list.id === weekly.id)).toMatchObject({ items: 3, checked: 1 });

  const notOnList = await call("set_shopping_item", { listId: topUp.id, groceryId: oats.id, checked: true });
  expect(notOnList.isError).toBe(true);
  expect(notOnList.content[0].text).toBe(
    "That grocery is no longer on this list. Refresh the list before changing it.",
  );
  expect((await read(topUp.id)).items.map((item) => item.groceryId)).toEqual([milk.id]);

  // Already at home: removal deletes the row from this list only.
  expect(
    await success("remove_shopping_items", { listId: weekly.id, groceryIds: [milk.id, "lifecycle-absent"] }),
  ).toEqual({ removed: 1 });
  expect((await read(weekly.id)).items.map((item) => item.groceryId)).toEqual([eggs.id, oats.id]);
  expect((await read(topUp.id)).items.map((item) => item.groceryId)).toEqual([milk.id]);
  expect(await success("remove_shopping_items", { listId: weekly.id, groceryIds: [milk.id] })).toEqual({
    removed: 0,
  });

  const snapshot = async () =>
    Promise.all(
      ["shopping_lists", "shopping_list_items"].map(
        async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results,
      ),
    );

  const before = await snapshot();

  for (const [name, args, message] of [
    [
      "add_shopping_items",
      { listId: weekly.id, items: [{ groceryId: milk.id }, { groceryId: "lifecycle-missing" }] },
      "Some of those groceries no longer exist. Refresh the groceries before adding them; no items were added.",
    ],
    [
      "add_shopping_items",
      { listId: "lifecycle-missing-list", items: [{ groceryId: milk.id }] },
      "That shopping list no longer exists. Refresh to see the current lists.",
    ],
    [
      "get_shopping_list",
      { listId: "lifecycle-missing-list" },
      "That shopping list no longer exists. Refresh to see the current lists.",
    ],
    [
      "update_shopping_list",
      { id: topUp.id, date, label: "Stale", expectedRevision: "stale" },
      "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
    ],
    [
      "update_shopping_list",
      { id: "lifecycle-never-created", date, label: "", expectedRevision: "invented" },
      "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
    ],
    [
      "delete_shopping_list",
      { id: weekly.id, expectedRevision: "stale" },
      "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
    ],
  ] as const) {
    const failed = await call(name, args);
    expect(failed.isError, name).toBe(true);
    expect(failed.content[0].text, name).toBe(message);
    expect(await snapshot(), name).toEqual(before);
  }

  for (const [name, args] of [
    ["add_shopping_items", { listId: weekly.id, items: [] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id }, { groceryId: milk.id }] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id, packages: 0 }] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id, packages: 1.5 }] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id, checked: 1 }] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id, sources: [{ title: " " }] }] }],
    ["add_shopping_items", { listId: weekly.id, items: [{ groceryId: milk.id }], extra: true }],
    ["set_shopping_item", { listId: weekly.id, groceryId: oats.id }],
    ["set_shopping_item", { listId: weekly.id, groceryId: oats.id, packages: 0 }],
    ["remove_shopping_items", { listId: weekly.id, groceryIds: [] }],
    ["remove_shopping_items", { listId: weekly.id, groceryIds: [oats.id, oats.id] }],
    ["create_shopping_list", { date: "2036-02-30" }],
    ["create_shopping_list", { date, label: "x".repeat(101) }],
    ["create_shopping_list", { date, id: "chosen-id" }],
    ["update_shopping_list", { id: topUp.id, date, label: "No guard" }],
    [
      "update_shopping_list",
      { id: topUp.id, date: "2036-13-01", label: "", expectedRevision: topUp.revision },
    ],
  ] as const) {
    expect((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(await snapshot(), name).toEqual(before);
  }

  // Bypass the test helper's revision convenience: an unguarded delete must be rejected.
  const unguarded = await rpc("tools/call", { name: "delete_shopping_list", arguments: { id: weekly.id } });

  if ("result" in unguarded) expect(CallToolResultSchema.parse(unguarded.result).isError).toBe(true);
  else expect(unguarded.error).toBeDefined();
  expect(await snapshot()).toEqual(before);

  // A failed update with an invented revision never creates the list.
  expect(
    (await success("list_shopping_lists", {})).lists.some((list) => list.id === "lifecycle-never-created"),
  ).toBe(false);

  const { list: moved } = await success("update_shopping_list", {
    id: topUp.id,
    date: "2036-03-02",
    label: " Saturday top-up ",
    expectedRevision: topUp.revision,
  });

  expect(moved).toEqual({
    id: topUp.id,
    date: "2036-03-02",
    label: "Saturday top-up",
    revision: expect.any(String),
  });
  expect(moved.revision).not.toBe(topUp.revision);

  const replay = await call("update_shopping_list", {
    id: topUp.id,
    date,
    label: "Stale replay",
    expectedRevision: topUp.revision,
  });

  expect(replay.isError).toBe(true);
  const movedRead = await read(topUp.id);
  expect(movedRead.list).toEqual(moved);
  expect(movedRead.items.map((item) => [item.groceryId, item.packages])).toEqual([[milk.id, 3]]);
  expect((await summary()).map((list) => list.id)).toEqual([weekly.id, topUp.id]);

  // Deleting a list removes all of its items and nothing else.
  await success("delete_shopping_list", { id: weekly.id, expectedRevision: weekly.revision });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM shopping_list_items WHERE list_id=?")
      .bind(weekly.id)
      .first("n"),
  ).toBe(0);
  expect((await call("get_shopping_list", { listId: weekly.id })).isError).toBe(true);
  expect(
    (await call("delete_shopping_list", { id: weekly.id, expectedRevision: weekly.revision })).isError,
  ).toBe(true);
  expect((await read(topUp.id)).items.map((item) => item.groceryId)).toEqual([milk.id]);
  expect((await success("list_groceries", {})).groceries.map((grocery) => grocery.id)).toEqual(
    expect.arrayContaining([oats.id, milk.id, eggs.id]),
  );

  await success("delete_shopping_list", { id: topUp.id, expectedRevision: moved.revision });
  expect(await summary()).toEqual([]);

  for (const grocery of [oats, milk, eggs]) await success("delete_grocery", { id: grocery.id });
});

it("shares small immutable photo references through MCP creation, updates, snapshot saves and reads", async () => {
  const upload = `data:image/jpeg;base64,${Buffer.from(await readFile("public/photos/chicken.jpg")).toString("base64")}`;

  const replacement =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S0AAAAASUVORK5CYII=";

  const {
    recipes: [source, other],
  } = await success("create_recipes", {
    recipes: [
      { ...draft("Shared photo source"), photo: upload },
      { ...draft("Shared photo copy"), photo: upload },
    ],
  });

  expect(source.photo).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
  expect(source.photo).toMatch(/^\/photos\/[a-z-]+\.jpg$/);
  expect(other.photo).toBe(source.photo);
  const db = await worker.getD1Database("DB");
  expect((await db.prepare("SELECT path,data FROM photos WHERE data=?").bind(upload).all()).results).toEqual([
    { path: source.photo, data: upload },
  ]);
  const range = { start: "2036-05-06", end: "2036-05-06" };
  const input = { recipeId: source.id, date: range.start, slot: "Dinner", scale: 1, note: "Shared photo" };
  const { revision: _revision, ...snapshot } = source;
  const { meal: first } = await success("save_meal", { ...input, recipe: { ...snapshot, photo: upload } });
  expect(first.recipe?.photo).toBe(source.photo);

  for (let index = 0; index < 12; index++)
    expect((await success("save_meal", input)).meal.recipe?.photo).toBe(source.photo);
  const listed = await call("list_meals", range);
  expect(listed.isError).not.toBe(true);
  expect(JSON.stringify(listed).length).toBeLessThan(upload.length);
  expect(JSON.stringify(listed)).not.toContain("data:image/");
  expect(listed.structuredContent.meals).toHaveLength(13);

  const {
    recipes: [updated],
  } = await success("update_recipes", {
    updates: [{ id: source.id, changes: { photo: replacement } }],
  });

  expect(updated.photo).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
  expect(updated.photo).not.toBe(source.photo);
  expect(
    (await success("list_meals", range)).meals.every((entry) => entry.recipe?.photo === source.photo),
  ).toBe(true);

  const { meal: changed } = await success("save_meal", {
    ...first,
    recipe: { ...snapshot, photo: replacement },
  });

  expect(changed.recipe?.photo).toBe(updated.photo);
  expect((await success("get_recipes", { ids: [other.id] })).recipes[0].photo).toBe(source.photo);
  expect((await success("get_recipes", { ids: [source.id] })).recipes[0].photo).toBe(updated.photo);

  const pointer = await success("update_recipes", {
    updates: [{ id: other.id, changes: { photo: updated.photo } }],
  });

  expect(pointer.recipes[0].photo).toBe(updated.photo);
  await success("update_recipes", { updates: [{ id: source.id, changes: { photo: "" } }] });
  expect(
    (await success("list_meals", range)).meals.find((entry) => entry.id === first.id)?.recipe?.photo,
  ).toBe(updated.photo);
  expect(
    (await success("save_meal", { ...changed, recipe: { ...snapshot, photo: "" } })).meal.recipe?.photo,
  ).toBe("");
  expect((await success("get_recipes", { ids: [other.id] })).recipes[0].photo).toBe(updated.photo);
  expect((await db.prepare("SELECT path,data FROM photos WHERE data=?").bind(upload).all()).results).toEqual([
    { path: source.photo, data: upload },
  ]);
  expect(
    (await db.prepare("SELECT path,data FROM photos WHERE data=?").bind(replacement).all()).results,
  ).toEqual([{ path: updated.photo, data: replacement }]);

  const beforeDeletion = (await success("list_meals", range)).meals;

  for (const recipe of [source, other]) await success("delete_recipe", { id: recipe.id });
  const detached = (await success("list_meals", range)).meals;
  expect(detached).toEqual(
    beforeDeletion.map((entry) => ({ ...entry, recipeId: null, revision: expect.any(String) })),
  );

  for (const entry of detached)
    expect(entry.revision).not.toBe(beforeDeletion.find((before) => before.id === entry.id)?.revision);
  const editable = detached[0];

  if (!editable.recipe) throw new Error("Missing detached snapshot");

  const edited = (
    await success("save_meal", {
      ...editable,
      recipe: { ...editable.recipe, title: "Meal after source deletion" },
    })
  ).meal;

  expect(edited.recipe?.title).toBe("Meal after source deletion");
  expect(edited.recipeId).toBeNull();
  const { recipe: _snapshot, ...schedule } = edited;
  const rescheduled = (await success("save_meal", { ...schedule, scale: 0.5, note: "" })).meal;
  expect(rescheduled.recipe).toEqual(edited.recipe);
  expect(rescheduled.scale).toBe(0.5);

  for (const entry of detached) await success("delete_meal", { id: entry.id });
  expect(
    (
      await db
        .prepare("SELECT path,data FROM photos WHERE data IN (?,?) ORDER BY data")
        .bind(upload, replacement)
        .all()
    ).results,
  ).toEqual([
    { path: source.photo, data: upload },
    { path: updated.photo, data: replacement },
  ]);
});

it("rejects missing photo pointers and malformed base64 through every MCP write without changing household records", async () => {
  const {
    recipes: [source],
  } = await success("create_recipes", { recipes: [draft("Invalid upload guard")] });

  const input = { recipeId: source.id, date: "2036-06-01", slot: "Dinner", scale: 1, note: "Guard" };
  const { meal } = await success("save_meal", input);
  const { revision: _revision, ...snapshot } = source;
  const db = await worker.getD1Database("DB");

  const read = async () => ({
    recipes: (await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results,
    meals: (await db.prepare("SELECT * FROM meals ORDER BY id").all()).results,
    photos: (await db.prepare("SELECT * FROM photos ORDER BY path").all()).results,
  });

  const before = await read();

  for (const photo of [
    `/photos/upload-${"a".repeat(64)}.jpg`,
    "/photos/upload-not-an-asset.jpg",
    "data:image/png;base64,A",
    "data:image/png;base64,AA=A",
    "data:image/png;base64,====",
    "data:image/png;base64,not base64!",
  ]) {
    expect(
      (
        await call("create_recipes", {
          recipes: [draft("Must not partially create"), { ...draft("Invalid photo"), photo }],
        })
      ).isError,
    ).toBe(true);
    expect((await call("update_recipes", { updates: [{ id: source.id, changes: { photo } }] })).isError).toBe(
      true,
    );
    expect((await call("save_meal", { ...meal, recipe: { ...snapshot, photo } })).isError).toBe(true);
    expect((await call("save_meal", { ...input, recipe: { ...snapshot, photo } })).isError).toBe(true);
    expect(await read()).toEqual(before);
  }

  await success("delete_meal", { id: meal.id });
  await success("delete_recipe", { id: source.id });
});

it("returns and edits independent meal recipes through MCP while preserving omitted snapshots", async () => {
  const {
    recipes: [source, otherSource],
  } = await success("create_recipes", {
    recipes: [draft("Meal snapshot source"), draft("Replacement meal source")],
  });

  const range = { start: "2035-05-06", end: "2035-05-08" };
  const input = { recipeId: source.id, date: range.start, slot: "Dinner", scale: 1.5, note: "Plan" };
  const { meal: first } = await success("save_meal", input);
  const { meal: second } = await success("save_meal", input);
  const { revision: _sourceRevision, ...sourceSnapshot } = source;
  const { revision: _otherRevision, ...otherSnapshot } = otherSource;
  expect(first.recipe).toEqual(sourceSnapshot);
  expect(second.recipe).toEqual(sourceSnapshot);

  const editedRecipe = {
    ...source,
    title: "Only this meal",
    description: "Meal description",
    servings: 3,
    minutes: 17,
    category: "Independent label",
    photo: "https://example.com/meal.jpg",
    source: "https://example.com/meal",
    rating: "down",
    ingredients: [
      {
        name: "Rice",
        originalText: "1 cup rice, rinsed",
        quantity: 1,
        unit: "cup",
        groceryItemId: null,
        grocerySuggestions: ["remembered-product"],
      },
    ],
    instructions: ["Meal-only instructions."],
  };

  expect((await success("save_meal", { ...first, recipe: editedRecipe })).meal.recipe).toEqual(editedRecipe);
  expect((await success("get_recipes", { ids: [source.id] })).recipes).toEqual([source]);
  await success("update_recipes", { updates: [{ id: source.id, changes: { title: "Changed source" } }] });

  const moved = {
    ...input,
    id: first.id,
    date: range.end,
    slot: "Lunch",
    scale: 2,
    note: "Moved without recipe",
  };

  const movedMeal = (await success("save_meal", moved)).meal;
  expect(movedMeal).toEqual({ ...moved, recipe: editedRecipe, revision: expect.any(String) });
  expect((await success("list_meals", range)).meals).toEqual([second, movedMeal]);

  for (const patch of [
    { recipe: null },
    { recipe: { ...source, id: otherSource.id } },
    { recipe: { ...source, ingredients: [] } },
    { recipe: { ...source, photo: `data:image/png;base64,${"a".repeat(1_900_000)}` } },
    { recipeId: null, recipe: { ...source, ingredients: [] } },
  ])
    expect((await call("save_meal", { ...moved, ...patch })).isError).toBe(true);
  expect((await success("list_meals", range)).meals).toEqual([second, movedMeal]);
  const changed = { ...moved, recipeId: otherSource.id };
  expect((await success("save_meal", changed)).meal).toEqual({
    ...changed,
    recipe: otherSnapshot,
    revision: expect.any(String),
  });
  const note = { ...changed, recipeId: null, recipe: null, note: "Pizza" };
  expect((await success("save_meal", note)).meal).toEqual({ ...note, revision: expect.any(String) });
  expect((await success("get_recipes", { ids: [source.id] })).recipes).toEqual([
    { ...source, title: "Changed source", revision: expect.any(String) },
  ]);

  for (const meal of [first, second]) await success("delete_meal", { id: meal.id });

  for (const recipe of [source, otherSource]) await success("delete_recipe", { id: recipe.id });
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

  expect(meal.recipe).toBeNull();
  expect((await success("list_meals", range)).meals).toEqual([meal]);
  expect((await success("list_shopping_lists", {})).lists).toEqual([]);
  expect((await call("save_meal", { ...meal, note: " \n\t" })).isError).toBe(true);
  const edited = { ...meal, note: "Dinner out", slot: "Lunch" };
  await success("save_meal", edited);
  expect((await success("list_meals", range)).meals).toEqual([{ ...edited, revision: expect.any(String) }]);
  await success("delete_meal", { id: meal.id });
  expect((await success("list_meals", range)).meals).toEqual([]);
});

it("imports an unsaved non-NYT draft, refuses unsafe URLs, and saves the reviewed draft", async () => {
  const before = (await success("search_recipes", {})).pagination.total;

  const imported = await success("import_recipe", {
    url: "https://recipes.example.com/coq-au-vin",
  });

  expect(imported.recipe).toMatchObject({
    title: "Coq au Vin",
    servings: 4,
    minutes: 120,
    source: "https://recipes.example.com/coq-au-vin",
  });
  expect(imported.recipe).not.toHaveProperty("id");
  expect(imported.recipe.ingredients.length).toBeGreaterThan(5);
  expect(imported.recipe.instructions.length).toBeGreaterThan(1);
  expect(imported.warnings).toEqual(expect.any(Array));

  for (const url of ["https://127.0.0.1/recipes/1", "http://cooking.nytimes.com/recipes/1"])
    expect((await call("import_recipe", { url })).isError).toBe(true);
  const redirected = await call("import_recipe", { url: "https://cooking.nytimes.com/recipes/999-redirect" });
  expect(redirected.isError).toBe(true);
  expect(redirected.content[0].text).toContain("The recipe page couldn’t be read");
  expect((await success("search_recipes", {})).pagination.total).toBe(before);

  const {
    recipes: [saved],
  } = await success("create_recipes", { recipes: [imported.recipe] });

  expect(saved).toEqual({ ...imported.recipe, id: saved.id, revision: expect.any(String) });
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

  expect((await success("list_shopping_lists", {})).lists).toEqual([]);
  await success("delete_meal", { id: meal.id });
  await success("delete_recipe", { id: large.id });

  // Earlier legacy scenarios deliberately leave recipes; remove them through the public tools.
  while (true) {
    const { recipes } = await success("search_recipes", {});

    if (!recipes.length) break;

    for (const recipe of recipes) await success("delete_recipe", { id: recipe.id });
  }

  // 2033-04-04 is Monday; samples are placed in the containing Saturday–Friday week.
  await success("add_demo_data", { today: "2033-04-04" });
  const recipes = await success("search_recipes", {});
  const meals = await success("list_meals", { start: "2033-04-02", end: "2033-04-08" });
  const lists = await success("list_shopping_lists", {});
  const shopping = await success("get_shopping_list", { listId: "sample-list" });
  expect(recipes.pagination.total).toBeGreaterThan(0);
  expect(meals.meals.map((meal) => meal.date)).toEqual([
    "2033-04-02",
    "2033-04-03",
    "2033-04-04",
    "2033-04-05",
    "2033-04-07",
  ]);
  expect(lists.lists).toEqual([
    { id: "sample-list", date: "2033-04-02", label: "", revision: expect.any(String), items: 2, checked: 0 },
  ]);
  expect(shopping.list).toEqual({
    id: "sample-list",
    date: "2033-04-02",
    label: "",
    revision: expect.any(String),
  });
  expect(shopping.items.map((item) => item.groceryId).sort()).toEqual(["sample-beans", "sample-spinach"]);
  expect(shopping.items.every((item) => !item.checked && item.packages === 1)).toBe(true);
  expect((await call("add_demo_data", { today: "2033-04-04" })).isError).toBe(true);
  expect(await success("search_recipes", {})).toEqual(recipes);
  expect(await success("list_meals", { start: "2033-04-02", end: "2033-04-08" })).toEqual(meals);
  expect(await success("list_shopping_lists", {})).toEqual(lists);
  expect(await success("get_shopping_list", { listId: "sample-list" })).toEqual(shopping);
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
    .find((event) => event.event === "mcp_tool_failure" && event.operation === "delete_recipe");

  if (!failure) throw new Error("Expected MCP failure telemetry missing");

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
