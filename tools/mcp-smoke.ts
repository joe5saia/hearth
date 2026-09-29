import assert from "node:assert/strict";

const origin = "https://hearth-mcp.joesaia.trade";
const request = (path: string) =>
  fetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });

const discovery = await request("/.well-known/oauth-authorization-server");
assert.equal(discovery.status, 200, "Public authorization-server discovery");
const metadata = await discovery.json();
assert.equal(metadata.issuer, origin);
assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
assert.equal(metadata.client_id_metadata_document_supported, true);
assert.deepEqual(metadata.scopes_supported, ["recipes"]);

const resource = await request("/.well-known/oauth-protected-resource/mcp");
assert.equal(resource.status, 200, "Public protected-resource discovery");
const protectedResource = await resource.json();
assert.equal(protectedResource.resource, `${origin}/mcp`);
assert.deepEqual(protectedResource.authorization_servers, [origin]);
assert.deepEqual(protectedResource.scopes_supported, ["recipes"]);

const mcp = await request("/mcp");
assert.equal(mcp.status, 401, "Anonymous MCP must use OAuth, not an Access redirect");
assert.ok(mcp.headers.get("www-authenticate")?.includes("Bearer"));
await mcp.body?.cancel();

const consent = await request("/authorize");
assert.equal(consent.status, 302, "Anonymous consent must reach the Access sign-in gate");
const login = new URL(consent.headers.get("location")!);
assert.equal(login.protocol, "https:");
assert.equal(login.hostname, "saiaai.cloudflareaccess.com");
await consent.body?.cancel();

console.log("MCP public smoke passed: discovery 200, resource metadata 200, MCP 401, consent Access 302.");
console.log("Authenticated consent, token exchange, and recipe reads require household login; not checked.");
