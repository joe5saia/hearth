import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";

const root = ".wrangler/mcp-preview";
const state = JSON.parse(await readFile(`${root}/state.json`, "utf8"));
const origin: string = state.url;
const accessHeaders = { "CF-Access-Client-Id": state.client_id, "CF-Access-Client-Secret": state.client_secret };
const redirectUri = "http://localhost:3456/callback";

async function request(path: string, init: RequestInit = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, "Refusing cross-origin request");
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30000) });
}

async function login() {
  const resource = await request("/.well-known/oauth-protected-resource/mcp");
  const scopes = (await resource.json()).scopes_supported as string[];
  assert.deepEqual(scopes, ["recipes"], "Single household scope advertised");
  const clientId = `${origin}/test-client.json`;
  const verifier = randomBytes(48).toString("base64url");
  const oauthState = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: scopes.join(" "), resource: `${origin}/mcp`, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: oauthState });
  let page: Response;
  for (let attempt = 0; ; attempt++) {
    page = await request(`/authorize?${query}`, { headers: accessHeaders });
    if (![302, 403].includes(page.status) || attempt === 11) break;
    await page.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert.equal(page.status, 200, "Access-authenticated consent page");
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle, "Consent form handle");
  // Inert, credential-free capture for browser inspection; never persist a live consent handle.
  await writeFile(`${root}/consent.html`, html.replace(handle, "visual-inspection-only").replace('<form method="post" action="/authorize">', '<form onsubmit="return false">'));
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const form = new URLSearchParams({ handle, decision: "approve" });
  scopes.forEach((scope) => form.append("scope", scope));
  const approved = await request("/authorize", { method: "POST", headers: { ...accessHeaders, Cookie: cookies, Origin: origin }, body: form });
  assert.equal(approved.status, 302, "Consent approval");
  const callback = new URL(approved.headers.get("location")!);
  assert.ok(callback.searchParams.get("state") === oauthState, "OAuth state matched");
  assert.ok(callback.searchParams.get("iss") === origin, "OAuth issuer matched");
  const response = await request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code: callback.searchParams.get("code")!, code_verifier: verifier, resource: `${origin}/mcp` }) });
  assert.equal(response.status, 200, "PKCE token exchange");
  const token = await response.json();
  assert.ok(token.access_token, "Access token issued");
  return { token: token.access_token as string, clientId };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, expectedProtocolError?: number) {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method });
  if (params.name) headers.set("Mcp-Name", String(params.name));
  const response = await request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "hearth-preview-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  assert.equal(response.status, 200, `MCP ${method} HTTP status`);
  const message = await response.json();
  if (expectedProtocolError !== undefined) {
    assert.equal(message.error?.code, expectedProtocolError, `MCP ${method} rejected`);
    return message.error;
  }
  assert.ok(!message.error, `MCP ${method} protocol success`);
  return message.result;
}

const metadata = await request("/.well-known/oauth-authorization-server");
assert.equal(metadata.status, 200, "Public OAuth discovery");
assert.equal((await metadata.json()).client_id_metadata_document_supported, true);
assert.equal((await request("/mcp")).status, 401, "Anonymous MCP denied without Access redirect");
assert.ok([302, 401, 403].includes((await request("/authorize")).status), "Anonymous consent denied");
const auth = await login();
const tools = (await rpc(auth.token, "tools/list")).tools;
assert.deepEqual(tools.map((tool: any) => tool.name).sort(), [
  "add_demo_data", "create_recipes", "delete_collection", "delete_grocery", "delete_meal",
  "delete_recipe", "delete_shopping_extra", "get_recipes", "get_shopping_list", "import_recipe",
  "list_collections", "list_groceries", "list_meals", "match_groceries", "save_collection",
  "save_grocery", "save_meal", "save_shopping_extra", "search_recipes", "set_shopping_checked",
  "set_shopping_order", "update_recipes",
]);
assert.ok(tools.every((tool: any) => tool.outputSchema?.type === "object"));
const ingredientProperties = tools.find((tool: any) => tool.name === "create_recipes").inputSchema.properties.recipes.items.properties.ingredients.items.properties;
assert.equal(ingredientProperties.name.type, "string", "Ingredient name is typed on the wire");
assert.equal(ingredientProperties.quantity.type, "number", "Ingredient quantity is typed on the wire");
assert.equal(ingredientProperties.unit.type, "string", "Ingredient unit is typed on the wire");
const call = async (name: string, args: object) => {
  const result = await rpc(auth.token, "tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} succeeded`);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
};
const collections = await call("list_collections", {});
for (const collection of [
  { id: "comfort", name: "Comfort food" },
  { id: "special", name: "Something special" },
  { id: "vegetarian", name: "Vegetarian" },
  { id: "weeknight", name: "Weeknight favorites" },
]) assert.ok(collections.collections.some((saved: any) => saved.id === collection.id && saved.name === collection.name), "Default collection remains available alongside eval fixtures");
const tag = `Evaluation ${Date.now()}`;
const fixture = (i: number) => ({ title: `${tag} ${String(i).padStart(2, "0")}`, servings: 3, minutes: 24 + i, category: "Vegetarian", ingredients: [{ name: "Chickpeas", quantity: 1.5, unit: "can" }, { name: "Lemon", quantity: 0.5, unit: "each" }], instructions: ["Rinse chickpeas.", "Mix with lemon."] });
const a = await call("create_recipes", { recipes: Array.from({ length: 25 }, (_, i) => fixture(i)) });
await call("create_recipes", { recipes: [fixture(25), fixture(26), fixture(27)] });
const first = await call("search_recipes", { query: tag });
assert.equal(first.recipes.length, 25); assert.equal(first.pagination.total, 28); assert.equal(first.pagination.nextOffset, 25);
const end = await call("search_recipes", { query: tag, offset: first.pagination.nextOffset });
assert.equal(end.recipes.length, 3); assert.equal(end.pagination.nextOffset, null);
const empty = await call("search_recipes", { query: `${tag} impossible` });
assert.equal(empty.pagination.total, 0); assert.equal(empty.pagination.hasMore, false);
const fetched = await call("get_recipes", { ids: [a.recipes[1].id, "does-not-exist", a.recipes[0].id] });
assert.deepEqual(fetched.missingIds, ["does-not-exist"]);
assert.equal(fetched.recipes[0].id, a.recipes[1].id);
const updated = await call("update_recipes", { updates: [{ id: a.recipes[0].id, changes: { minutes: 73 } }, { id: a.recipes[1].id, changes: { rating: "up" } }] });
assert.deepEqual(updated.recipes[0], { ...a.recipes[0], minutes: 73 });
assert.deepEqual(updated.recipes[1], { ...a.recipes[1], rating: "up" });
const categorized = await call("update_recipes", { updates: [{ id: a.recipes[2].id, changes: { category: collections.collections[0].name } }] });
assert.deepEqual(categorized.recipes[0], { ...a.recipes[2], category: "Comfort food" });
const uncategorized = await call("update_recipes", { updates: [{ id: a.recipes[2].id, changes: { category: "" } }] });
assert.deepEqual(uncategorized.recipes[0], { ...a.recipes[2], category: "" });

// Exercise new shared-state capabilities through the same recipes OAuth grant.
const { collection } = await call("save_collection", { name: `${tag} collection` });
const { grocery } = await call("save_grocery", { name: `${tag} rice`, url: "", aisle: "Pantry", quantity: 400, unit: "g", aliases: [`${tag} grain`] });
const { recipes: [planned] } = await call("create_recipes", { recipes: [{ ...fixture(99), category: collection.name, ingredients: [{ name: `${tag} grain`, quantity: 250, unit: "g" }] }] });
assert.equal(planned.ingredients[0].groceryItemId, grocery.id);
await call("save_collection", { id: collection.id, name: `${tag} renamed` });
assert.equal((await call("get_recipes", { ids: [planned.id] })).recipes[0].category, `${tag} renamed`);
const { meal } = await call("save_meal", { recipeId: planned.id, date: "2035-06-04", slot: "Dinner", scale: 2.5, note: "Live OAuth workflow" });
const range = { start: meal.date, end: meal.date };
assert.ok((await call("list_meals", range)).meals.some((entry: any) => entry.id === meal.id));
let shopping = await call("get_shopping_list", range);
const item = shopping.items.find((entry: any) => entry.grocery?.id === grocery.id);
assert.equal(item.needs[0].quantity, 625); assert.equal(item.packages, 2);
await call("set_shopping_checked", { key: item.checkKey, checked: true });
assert.equal((await call("get_shopping_list", range)).items.find((entry: any) => entry.key === item.key).checked, true);
await call("save_meal", { ...meal, scale: 3 });
shopping = await call("get_shopping_list", range);
assert.equal(shopping.items.find((entry: any) => entry.key === item.key).checked, false);
await call("set_shopping_order", { aisles: ["Pantry"], items: [item.key] });
assert.deepEqual((await call("get_shopping_list", range)).shoppingOrder, { aisles: ["Pantry"], items: [item.key] });
const { extra } = await call("save_shopping_extra", { name: `${tag} towels`, checked: 0 });
await call("save_shopping_extra", { ...extra, checked: 1 });
assert.ok((await call("get_shopping_list", range)).extras.some((entry: any) => entry.id === extra.id && entry.checked === 1));
assert.ok((await call("list_groceries", {})).groceries.some((entry: any) => entry.id === grocery.id));
await call("match_groceries", {});
for (const [name, args] of [["delete_recipe", { id: planned.id }], ["delete_grocery", { id: grocery.id }], ["add_demo_data", { today: meal.date }], ["import_recipe", { url: "https://example.com/recipe" }]] as const) {
  assert.equal((await rpc(auth.token, "tools/call", { name, arguments: args })).isError, true, `${name} rejects unsafe operation`);
}
await call("delete_collection", { id: collection.id });
assert.equal((await call("get_recipes", { ids: [planned.id] })).recipes[0].category, "");
await call("delete_meal", { id: meal.id });
await call("delete_recipe", { id: planned.id });
await call("delete_grocery", { id: grocery.id });
await call("delete_shopping_extra", { id: extra.id });
await call("set_shopping_checked", { key: item.checkKey, checked: false });
await call("set_shopping_order", { aisles: [], items: [] });

await writeFile(`${root}/evaluation.json`, JSON.stringify({ tag, count: 28, url: `${origin}/eval/mcp` }, null, 2));
console.log(JSON.stringify({ checks: "Public discovery, Access-protected consent, live CIMD + PKCE exchange, unchanged recipes grant, 22 tools, structured/text parity, 25+3 pagination, ordered gets, field-preserving updates, collection propagation, grocery matching, meal scaling, package rounding, shopping checks and invalidation, route/extras, deletion guards and cleanup, invalid import and nonempty demo refusal", evaluationTag: tag, fixtures: 28, eval: `${origin}/eval/mcp`, credentials: "Eval orbs mint their own Amp identity; no copied bearer settings or tokens logged" }, null, 2));
