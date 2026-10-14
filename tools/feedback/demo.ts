import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { dateKey } from "../../src/domain.ts";

// Local-only built SPA + real Worker + ephemeral D1. No production resources or household.
const live = process.argv.includes("--live-intake");
assert(process.argv.slice(2).every(arg => arg === "--live-intake"), "Use --live-intake or no arguments");
const secrets: Record<string, string> = {};
if (live) {
  const owner = JSON.parse(await readFile(".amp/feedback-state/owner.json", "utf8"));
  secrets.FEEDBACK_SIGNING_KEY = owner.signingKey;
  secrets.FEEDBACK_WEBHOOK_URL = (await readFile(".amp/feedback-state/webhook-url", "utf8")).trim();
  assert(secrets.FEEDBACK_SIGNING_KEY && secrets.FEEDBACK_WEBHOOK_URL, "Private intake configuration required");
}
const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
const output = await bundle.generate({ format: "esm" });
await bundle.close();
const entry = output.output.find(item => item.type === "chunk" && item.isEntry);
assert(entry?.type === "chunk");
const worker = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: "hearth-feedback-demo", modules: true, script: entry.code,
  compatibilityDate: "2026-09-08", d1Databases: ["DB"],
  bindings: { LOCAL_DEV: "true", ...secrets },
}] }));
const db = await worker.getD1Database("DB");
for (const file of (await readdir("migrations")).filter(file => file.endsWith(".sql")).sort()) {
  const sql = await readFile(`migrations/${file}`, "utf8");
  await db.batch(sql.split(/;\n(?=CREATE|INSERT|DROP|ALTER)|;\s*$/).filter(statement => statement.trim()).map(statement => db.prepare(statement)));
}
await worker.dispatchFetch(`http://localhost/api/demo?today=${dateKey(new Date())}`, { method: "POST", headers: { "Content-Type": "application/json" } });
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost:8790");
    if (url.pathname.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 20000) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await worker.dispatchFetch(url, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const file = resolve("dist", url.pathname === "/" ? "index.html" : `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(resolve("dist") + "/")) { response.writeHead(404); response.end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(500); response.end("Demo request failed.");
  }
});
server.listen(8790, "0.0.0.0", () => console.log(`Feedback demo ready on port 8790. Intake ${live ? "connected; submissions create real isolated Amp tasks" : "disconnected; drafts are preserved, no fake acknowledgements"}. Sample household only.`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, async () => { server.close(); await worker.dispose(); process.exit(0); });
