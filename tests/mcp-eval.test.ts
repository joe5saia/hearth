import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from "jose";
import { z } from "zod";

let worker: Miniflare;

let signingKey: CryptoKey;

let forgedKey: CryptoKey;

const origin = "https://preview.example.com";

const issuer = "https://ampcode.com/api/workload-identity";

const claims = {
  iss: issuer,
  aud: origin,
  sub: "user:owner:project:meal-planning:user:owner:thread:eval-a",
  project_id: "meal-planning",
  user_id: "owner",
  thread_id: "eval-a",
  token_use: "exchanged",
};

const sign = (overrides: JWTPayload = {}, key = signingKey) =>
  new SignJWT({ ...claims, exp: Math.floor(Date.now() / 1000) + 600, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "amp-test" })
    .sign(key);

async function request(
  bearer: string,
  method = "tools/list",
  params: { name?: string; arguments?: object } = {},
  path = "/eval/mcp",
  target = "preview",
  targetOrigin = origin,
) {
  const service = await worker.getWorker(target);

  const headers = new Headers({
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  });

  if (params.name) headers.set("Mcp-Name", params.name);

  return service.fetch(targetOrigin + path, {
    method: "POST",
    headers: Object.fromEntries(headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "eval-smoke", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  signingKey = keys.privateKey;
  forgedKey = (await generateKeyPair("RS256")).privateKey;
  const publicKeys = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "amp-test", alg: "RS256" }] };
  const workers = [];

  for (const name of ["preview", "unconfigured", "production"]) {
    const bundle = await rolldown({
      input: name === "production" ? "src/mcp-worker.ts" : "tools/mcp-preview-worker.ts",
      platform: "browser",
      external: ["cloudflare:workers", "node:async_hooks"],
      resolve: { conditionNames: ["workerd", "browser", "import", "default"] },
    });

    const output = await bundle.generate({ format: "esm" });
    await bundle.close();
    const script = output.output.find((item) => item.type === "chunk")!;

    if (script.type !== "chunk") throw new Error("Bundle missing");
    workers.push({
      name,
      modules: true,
      script: script.code,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      bindings: {
        MCP_ORIGIN: origin,
        ACCESS_AUD: "oauth-test",
        AMP_EVAL_PROJECT_ID: name === "unconfigured" ? "" : "meal-planning",
        AMP_EVAL_USER_ID: "owner",
      },
      outboundService: async (req: Request) =>
        req.url === `${issuer}/jwks.json`
          ? Response.json(publicKeys)
          : new Response("Not found", { status: 404 }),
    });
  }

  worker = new Miniflare(convertV4MiniflareOptions({ workers }));
  const db = await worker.getD1Database("DB", "preview");

  for (const file of ["0001_initial.sql", "0002_recipe_rating.sql", "0003_collections.sql"]) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql
        .split(/;\n(?=CREATE|INSERT)|;\s*$/)
        .filter((statement) => statement.trim())
        .map((statement) => db.prepare(statement)),
    );
  }
}, 30000);

afterAll(async () => worker?.dispose());

it("lets separate authorized eval threads discover collections and patch recipes through real D1", async () => {
  const first = await sign();
  const second = await sign({ thread_id: "eval-b", sub: "user:owner:project:meal-planning:thread:eval-b" });
  const listed = await request(first, "tools/call", { name: "list_collections", arguments: {} });
  expect(listed.status).toBe(200);
  const collections = z.object({ result: z.any() }).parse(await listed.json()).result;
  expect(collections.structuredContent.collections).toEqual([
    { id: "comfort", name: "Comfort food" },
    { id: "special", name: "Something special" },
    { id: "vegetarian", name: "Vegetarian" },
    { id: "weeknight", name: "Weeknight favorites" },
  ]);
  expect(JSON.parse(collections.content[0].text)).toEqual(collections.structuredContent);

  const created = await request(first, "tools/call", {
    name: "create_recipes",
    arguments: {
      recipes: [
        {
          title: "Identity eval soup",
          servings: 3,
          minutes: 27,
          category: "Vegetarian",
          ingredients: [{ name: "Lentils", quantity: 1.5, unit: "cup" }],
          instructions: ["Simmer lentils."],
        },
      ],
    },
  });

  expect(created.status).toBe(200);
  const saved = z.object({ result: z.any() }).parse(await created.json()).result.structuredContent.recipes[0];

  const updated = await request(second, "tools/call", {
    name: "update_recipes",
    arguments: { updates: [{ id: saved.id, changes: { category: "Something special" } }] },
  });

  expect(updated.status).toBe(200);
  expect(
    z.object({ result: z.any() }).parse(await updated.json()).result.structuredContent.recipes[0],
  ).toEqual({
    ...saved,
    category: "Something special",
  });

  const read = await request(await sign({ jti: "fresh-token" }), "tools/call", {
    name: "get_recipes",
    arguments: { ids: [saved.id] },
  });

  expect(z.object({ result: z.any() }).parse(await read.json()).result.structuredContent.recipes[0]).toEqual({
    ...saved,
    category: "Something special",
  });
});

it("rejects invalid identities before writes, fails closed without policy, and leaves production OAuth intact", async () => {
  const db = await worker.getD1Database("DB", "preview");
  const before = (await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results;

  const invalid = [
    "",
    "malformed",
    await sign({}, forgedKey),
    await sign({ iss: "https://other.example.com" }),
    await sign({ aud: "https://another-preview.example.com" }),
    await sign({ exp: Math.floor(Date.now() / 1000) - 1 }),
    await sign({ exp: undefined }),
    await sign({ nbf: Math.floor(Date.now() / 1000) + 60 }),
    await sign({ project_id: "other-project" }),
    await sign({ user_id: "other-user" }),
    await sign({ thread_id: "" }),
    await sign({ thread_id: undefined }),
    await sign({ token_use: "mcp" }),
  ];

  for (const bearer of invalid) {
    const denied = await request(bearer, "tools/call", {
      name: "update_recipes",
      arguments: { updates: [{ id: before[0].id, changes: { title: "Must not persist" } }] },
    });

    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "invalid_token" });
  }

  expect((await db.prepare("SELECT * FROM recipes ORDER BY id").all()).results).toEqual(before);
  const valid = await sign();
  expect((await request(valid, "tools/list", {}, "/eval/mcp", "unconfigured")).status).toBe(401);
  expect(
    (await request(valid, "tools/list", {}, "/eval/mcp", "preview", "https://other.example.com")).status,
  ).toBe(421);
  expect((await request(valid, "tools/list", {}, "/mcp")).status).toBe(401);
  expect((await request(valid, "tools/list", {}, "/mcp", "production")).status).toBe(401);
  expect((await request(valid, "tools/list", {}, "/eval/mcp", "production")).status).toBe(404);
});
