import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import { consentPage } from "../src/mcp-consent";
import { updateRecipes } from "../src/recipes";

let worker: Miniflare;

let assertion: string;

let token: string;

let signingKey: CryptoKey;

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
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
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

  return response.error ? { isError: true, protocolError: response.error } : response.result;
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
          bindings: { MCP_ORIGIN: origin, ACCESS_AUD: "mcp-test", PREVIEW_CLIENT_ID: "preview-test.access" },
          outboundService: async (req) => {
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

  for (const file of ["0001_initial.sql", "0002_recipe_rating.sql", "0003_collections.sql"]) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql
        .split(/;\n(?=CREATE|INSERT)|;\s*$/)
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }

  token = await login();
}, 30000);

afterAll(async () => worker?.dispose());

it("escapes consent metadata and renders only the requested permissions", () => {
  const html = consentPage(
    {
      clientId,
      clientName: '<img src=x onerror="alert(1)">',
      redirectUri,
      redirectHost: "client.example.com",
      redirectIsLoopback: false,
      scope: scopes,
    },
    'opaque"handle',
  );

  expect(html).not.toContain("<img");
  expect(html).toContain("&#60;img");
  expect(html).toContain('value="opaque&#34;handle"');
  expect(html).toContain('name="scope" value="recipes" checked');
  expect(html).toContain("Manage household recipes");
  expect(html).toContain("Search, view, create and edit your household recipes.");
  expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  expect(html).not.toContain('value="recipes:read"');
  expect(html).not.toContain('value="recipes:write"');
  expect(html).not.toContain("(on this computer)");
  expect(html).toContain('name="decision" value="deny"');
  expect(html).toContain("This app’s name is unverified");
  expect(html).not.toContain("Any process on your computer");
});

it("shows the CIMD domain independently of the claimed name and warns for local apps", () => {
  const html = consentPage(
    {
      clientId,
      clientName: "Trusted Assistant",
      clientDomain: "attacker.example<iframe>",
      redirectUri,
      redirectHost: "localhost",
      redirectIsLoopback: true,
      scope: scopes,
    },
    "handle",
  );

  expect(html).toContain("Trusted Assistant");
  expect(html).toContain("Client domain: <strong>attacker.example&#60;iframe&#62;</strong>");
  expect(html).not.toContain("<iframe>");
  expect(html).not.toContain("This app’s name is unverified");
  expect(html).toContain("Continue only if you just started connecting from this local app");
  expect(html).toContain("Any process on your computer could be listening");
});

it("allows OAuth grants for only the configured preview service and rejects unrelated identities", async () => {
  const sign = (claims: { sub: string; common_name?: string; email?: string }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://saiaai.cloudflareaccess.com")
      .setAudience("mcp-test")
      .setExpirationTime("1h")
      .sign(signingKey);

  const preview = await login(scopes, false, await sign({ sub: "", common_name: "preview-test.access" }));
  expect((await rpc("tools/list", {}, preview)).result.tools).toHaveLength(4);

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

it("publishes all four code-mode-friendly schemas with the single recipes scope", async () => {
  const tools = (await rpc("tools/list")).result.tools;
  expect(tools.map((t: any) => t.name).sort()).toEqual([
    "create_recipes",
    "get_recipes",
    "search_recipes",
    "update_recipes",
  ]);

  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema.type).toBe("object");
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

  await expect(
    updateRecipes(racingDb, [
      { id: a.id, changes: { minutes: 91 } },
      { id: b.id, changes: { title: "Deleted" } },
    ]),
  ).rejects.toThrow("No recipes were updated");
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
