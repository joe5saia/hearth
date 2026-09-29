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

async function login(label: string, cimd: boolean, scopes = ["recipes:read", "recipes:write"]) {
  let clientId = `${origin}/test-client.json`;
  if (!cimd) {
    const response = await request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: label, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(response.status, 201, "Client registration");
    clientId = (await response.json()).client_id;
  }
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
const auth = await login("CIMD smoke", true);
const tools = (await rpc(auth.token, "tools/list")).tools;
assert.equal(tools.length, 4);
assert.ok(tools.every((tool: any) => tool.outputSchema?.type === "object"));
const call = async (name: string, args: object) => {
  const result = await rpc(auth.token, "tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} succeeded`);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
};
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

const readOnly = await login("Read-only evaluation", false, ["recipes:read"]);
assert.deepEqual((await rpc(readOnly.token, "tools/list")).tools.map((tool: any) => tool.name), ["search_recipes", "get_recipes"]);
await rpc(readOnly.token, "tools/call", { name: "create_recipes", arguments: { recipes: [fixture(99)] } }, -32602);

for (const label of ["self", "low-a", "low-b"]) {
  const identity = await login(`Hearth ${label} evaluation`, false);
  await writeFile(`${root}/${label}-settings.json`, JSON.stringify({ "amp.mcpServers": { hearth_preview: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${identity.token}` } } } }), { mode: 0o600 });
}
await writeFile(`${root}/evaluation.json`, JSON.stringify({ tag, count: 28, url: `${origin}/mcp` }, null, 2));
console.log(JSON.stringify({ checks: "Public discovery, Access-protected consent, live CIMD + PKCE exchange, four tools, structured/text parity, 25+3 pagination, empty pagination, ordered gets, missing IDs, field-preserving batch updates, read-only scope enforcement", evaluationTag: tag, fixtures: 28, credentials: "Separate evaluation credentials saved privately; no tokens logged" }, null, 2));
