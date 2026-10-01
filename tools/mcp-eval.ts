import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const issuer = "https://ampcode.com/api/workload-identity";
const keys = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));

export async function ampIdentity(audience: string) {
  let token: string;
  try {
    token = execFileSync("amp", ["orb", "id-token", "--audience", audience], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Could not mint an Amp orb identity. Run this task inside the authorized project's orb.");
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer, audience, algorithms: ["RS256"],
    requiredClaims: ["exp", "sub", "project_id", "user_id", "thread_id", "token_use"],
  });
  const identity = z.object({
    project_id: z.string().min(1), user_id: z.string().min(1), thread_id: z.string().min(1), token_use: z.literal("exchanged"),
  }).parse(payload);
  return { token, ...identity };
}

function previewEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/eval/mcp" ||
    !/^(p\d{6}-[a-f0-9]{10}-mcp)-hearth-mcp-\1\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
  ) throw new Error("Expected an isolated Hearth Preview HTTPS /eval/mcp URL; production is not allowed.");
  return url;
}

async function readSettings(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read settings; refusing to overwrite them.");
  }
}

async function main() {
  const [operation, value] = process.argv.slice(2);
  if (!["connect", "check", "disconnect"].includes(operation) || !value)
    throw new Error("Usage: npx task mcp:eval -- connect|check|disconnect <Preview /eval/mcp URL>");
  const url = previewEndpoint(value);
  const settingsPath = resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "amp/settings.json");
  if (operation !== "disconnect") {
    const identity = await ampIdentity(url.origin);
    const response = await fetch(url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "hearth-eval-bootstrap", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    });
    if (response.status !== 200) throw new Error(`Preview discovery failed: HTTP ${response.status}. Settings were not changed.`);
    const discovered = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })).min(1) }) }).parse(await response.json());
    if (operation === "check") {
      console.log(JSON.stringify({ status: "authenticated", tools: discovered.result.tools.map((tool) => tool.name) }));
      return;
    }
    const workspace = await readSettings(resolve(".amp/settings.json"));
    if (workspace["amp.mcpServers"]?.hearth_eval)
      throw new Error("A workspace hearth_eval entry would override the trusted user configuration. Remove that entry explicitly first.");
  }
  const settings = await readSettings(settingsPath);
  const servers = settings["amp.mcpServers"] ?? {};
  if (operation === "disconnect") {
    if (!servers.hearth_eval) { console.log("No eval connection installed"); return; }
    if (servers.hearth_eval.url !== url.href || servers.hearth_eval.headers?.Authorization !== "Bearer ${amp:id-token}")
      throw new Error("Refusing to remove a different MCP connection.");
    delete servers.hearth_eval;
  } else {
    if (servers.hearth_eval && servers.hearth_eval.headers?.Authorization !== "Bearer ${amp:id-token}")
      throw new Error("Refusing to overwrite an unrelated hearth_eval connection.");
    servers.hearth_eval = { url: url.href, headers: { Authorization: "Bearer ${amp:id-token}" } };
  }
  settings["amp.mcpServers"] = servers;
  await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
  // Tighten permissions before overwriting an existing file that may contain other private settings.
  try { await chmod(settingsPath, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  console.log(operation === "connect" ? "Installed hearth_eval with automatically refreshed Amp identity. Reload MCP to discover tools; no bearer token was saved." : "Removed the eval connection. Reload MCP to unload tools.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Do not print library/CLI errors that could contain token or configuration data.
    console.error("MCP eval bootstrap failed. Check the Preview URL, identity authorization, connectivity, and settings conflicts. No credentials were logged.");
    process.exitCode = 1;
  });
}
