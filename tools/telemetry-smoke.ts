import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { promisify } from "node:util";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { Schema } from "effect";
import { dateKey } from "../src/domain.ts";

// A real built SPA, Worker, D1 and ingestion protocol; faults occur at the HTTP boundary.
const run = promisify(execFile);
const live = process.argv.includes("--live");
assert(process.argv.slice(2).every(argument => argument === "--live"), "Use --live or no arguments");
const token = live ? process.env.AXIOM_TOKEN : "disposable-browser-ingestion";
assert(token, "AXIOM_TOKEN must be supplied securely for live ingestion");
const region = live ? (process.env.AXIOM_REGION ?? "us-east-1") : "us-east-1";
assert(["us-east-1", "eu-central-1"].includes(region), "Unsupported Axiom region");
const eventsDataset = live ? (process.env.AXIOM_EVENTS_DATASET ?? "hearth-events") : "browser-smoke";
const tracesDataset = live ? (process.env.AXIOM_TRACES_DATASET ?? "hearth-traces") : "browser-smoke-traces";
const version = `validation-${crypto.randomUUID()}`;
const acceptedEvents: Record<string, string | number | boolean>[] = [];
const acceptedSpans: { traceId: string; spanId: string; name: string; parentSpanId?: string }[] = [];
const deliveries: { signal: string; status: number; accepted: number; rejected: number }[] = [];
const session = `telemetry-${process.pid}`;
const browser = async (...args: string[]) => (await run("agent-browser", ["--session", session, ...args], { timeout: 90000 })).stdout.trim();
const events: Record<string, string | number | boolean>[] = [];
const payloads: string[] = [];
let failWrite: string | undefined;
let failRefresh = false;
let failNetwork = false;
let failDecode = false;
let ingestionStatus = 200;
let ingestionEnabled = true;
const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
const output = await bundle.generate({ format: "esm" });
await bundle.close();
const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
assert(entry?.type === "chunk");
const worker = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: "browser-telemetry-smoke", modules: true, script: entry.code, compatibilityDate: "2026-09-08", d1Databases: ["DB"],
  bindings: { LOCAL_DEV: "true", AXIOM_TOKEN: token, AXIOM_EVENTS_DATASET: eventsDataset, AXIOM_TRACES_DATASET: tracesDataset, AXIOM_REGION: region, TELEMETRY_ENVIRONMENT: live ? "validation" : "smoke", TELEMETRY_VERSION: version },
  outboundService: async (request) => {
    const url = new URL(request.url);
    assert(url.origin === `https://${region}.aws.edge.axiom.co`);
    const isEvents = url.pathname === `/v1/ingest/${encodeURIComponent(eventsDataset)}`;
    assert(isEvents || url.pathname === "/v1/traces");
    const body = await request.text();
    payloads.push(body);
    const batch = isEvents ? Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))))(JSON.parse(body)) : [];
    events.push(...batch);
    if (live && ingestionStatus === 200) {
      // Check privacy before sending. The real token stays in Worker/receiver bindings, never the SPA.
      assert(!body.includes(token) && !/PRIVATE-|Private |private\.example/.test(body), "Unsafe export payload");
      const spans = isEvents ? [] : Schema.decodeUnknownSync(Schema.Struct({ resourceSpans: Schema.Array(Schema.Struct({ scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Schema.Struct({ traceId: Schema.String, spanId: Schema.String, name: Schema.String, parentSpanId: Schema.optional(Schema.String) })) })) })) }))(JSON.parse(body)).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
      const signal = isEvents ? "events" : "traces";
      try {
        const response = await fetch(url, { method: "POST", headers: request.headers, body, signal: AbortSignal.timeout(2000) });
        const content = await response.text();
        let rejected = 0;
        let accepted = 0;
        if (response.ok) {
          if (isEvents) {
            const result = Schema.decodeUnknownSync(Schema.Struct({ ingested: Schema.Number, failed: Schema.Number }))(JSON.parse(content));
            accepted = result.ingested;
            rejected = result.failed;
          } else {
            const result = Schema.decodeUnknownSync(Schema.Struct({
              partialSuccess: Schema.optional(Schema.Struct({
                rejectedSpans: Schema.optional(Schema.Union([
                  Schema.Number, Schema.String.check(Schema.isPattern(/^\d+$/)),
                ])),
              })),
            }))(JSON.parse(content || "{}"));
            rejected = Number(result.partialSuccess?.rejectedSpans ?? 0);
            accepted = spans.length - rejected;
          }
        }
        deliveries.push({ signal, status: response.status, accepted, rejected });
        if (response.ok && rejected === 0) {
          assert(accepted === (isEvents ? batch.length : spans.length), "Axiom accepted an unexpected count");
          acceptedEvents.push(...batch);
          acceptedSpans.push(...spans);
        }
        // Return the original status/body to exercise the application's real export diagnostics.
        return new Response(content, { status: response.status, headers: response.headers });
      } catch {
        deliveries.push({ signal, status: 0, accepted: 0, rejected: 0 });
        return new Response(null, { status: 502 });
      }
    }
    return Response.json({ ingested: 1, failed: 0 }, { status: ingestionStatus });
  },
}] }));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (failNetwork && path === "/api/extras") {
        // Keep the fault active through any automatic transport-level retries.
        request.socket.destroy();
        return;
      }
      if ((path === failWrite && request.method === "PUT") || (failRefresh && path === "/api/household")) {
        failWrite = undefined; failRefresh = false;
        response.writeHead(503, { "Content-Type": "application/json", "X-Hearth-Telemetry": "1" });
        response.end(JSON.stringify({ error: "Temporary smoke fault" }));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await worker.dispatchFetch(`http://${request.headers.host}${path}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const outgoing = new Headers(result.headers);
      if (!ingestionEnabled) outgoing.set("X-Hearth-Telemetry", "0");
      response.writeHead(result.status, Object.fromEntries(outgoing));
      if (failDecode && path === "/api/household") {
        failDecode = false;
        response.end('{"recipes":"PRIVATE-INVALID-HOUSEHOLD"}');
        return;
      }
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const file = resolve("dist", path === "/" ? "index.html" : `.${path}`);
    assert(file.startsWith(resolve("dist") + "/"));
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png" };
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(file));
  } catch {
    response.writeHead(500); response.end("Smoke harness failure");
  }
});
const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) {
    assert(!deliveries.some(delivery => delivery.status < 200 || delivery.status >= 300 || delivery.rejected > 0), `Live Axiom delivery failed: ${JSON.stringify(deliveries)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(predicate(), label);
  console.log(`PASS ${label}`);
};

try {
  const db = await worker.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter(file => file.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(sql.split(/;\n(?=CREATE|INSERT|DROP|ALTER)|;\s*$/).filter(statement => statement.trim()).map(statement => db.prepare(statement)));
  }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await worker.dispatchFetch(`${url}/api/demo?today=${dateKey(new Date())}`, { method: "POST", headers: { "Content-Type": "application/json" } });
  await browser("open", `${url}/#shopping`);
  await browser("set", "viewport", "1280", "900", "2");
  await browser("wait", ".purchase-row");
  const submitExtra = async (name: string) => {
    await browser("fill", ".extra-form input", name);
    await browser("click", '[aria-label="Add household item"]');
  };
  const privateName = "PRIVATE-BROWSER-CONTENT-NEVER-EXPORT";
  await submitExtra(privateName);
  await waitFor(() => events.some(event => event.event === "browser_mutation" && event.outcome === "success"), "successful browser mutation exported");
  const saved = await db.prepare("SELECT id FROM extras WHERE name=?").bind(privateName).first("id");
  assert(saved);
  const mutation = events.find(event => event.event === "browser_mutation" && event.outcome === "success")!;
  assert(events.some(event => event.event === "server_request" && event.operation === "extras" && event.operationId === mutation.relatedOperationId));
  const request = events.find(event => event.event === "browser_request" && event.operation === "extras" && event.relatedOperationId === mutation.relatedOperationId)!;
  assert(events.some(event => event.event === "server_request" && event.traceId === request.relatedTraceId && event.requestId === request.relatedRequestId));
  assert(events.some(event => event.event === "browser_household" && event.initial === true && Number(event.bytes) > 1000 && event.outcome === "success"));
  console.log("PASS browser→write→refresh correlation, initial payload/download/decode measurements and D1 persistence");
  failWrite = "/api/extras";
  await submitExtra("Private rejected extra");
  await waitFor(() => events.some(event => event.event === "browser_mutation" && event.outcome === "error" && event.acknowledged === false), "rejected write is not reported as acknowledged");
  assert.equal(await db.prepare("SELECT id FROM extras WHERE name='Private rejected extra'").first("id"), null);
  failRefresh = true;
  await submitExtra("Private saved refresh failure");
  await waitFor(() => events.some(event => event.event === "browser_mutation" && event.outcome === "saved_refresh_failed" && event.acknowledged === true), "saved write with failed refresh remains distinguishable");
  assert(await db.prepare("SELECT id FROM extras WHERE name='Private saved refresh failure'").first("id"));
  failNetwork = true;
  await submitExtra("Private network rejection");
  await waitFor(() => events.some(event => event.event === "browser_request" && event.outcome === "network_error"), "real network disconnect is classified without exception text");
  failNetwork = false;
  assert.equal(await db.prepare("SELECT id FROM extras WHERE name='Private network rejection'").first("id"), null);
  failDecode = true;
  await submitExtra("Private saved decode failure");
  await waitFor(() => events.some(event => event.event === "browser_household" && event.reason === "decode_error"), "invalid household response is reported separately from HTTP failure");
  assert(await db.prepare("SELECT id FROM extras WHERE name='Private saved decode failure'").first("id"));
  await browser("eval", "document.querySelector('.purchase-row input[type=checkbox]').click(); true");
  await waitFor(() => events.some(event => event.event === "browser_shopping_save" && event.outcome === "success" && event.queueDepth === 1 && event.acknowledged === true), "optimistic shopping write/queue/refresh exported");
  assert(Number((await db.prepare("SELECT COUNT(*) FROM checks").first("COUNT(*)"))) > 0);
  failWrite = "/api/checks";
  await browser("eval", "document.querySelector('.purchase-row input[type=checkbox]').click(); true");
  await waitFor(() => events.some(event => event.event === "browser_shopping_save" && event.outcome === "error" && event.acknowledged === false), "shopping write rejection recorded and optimistic checkbox rolled back");
  assert.equal(await browser("eval", "document.querySelector('.purchase-row input[type=checkbox]').checked"), "true");
  failRefresh = true;
  await browser("eval", "document.querySelector('.purchase-row input[type=checkbox]').click(); true");
  await waitFor(() => events.some(event => event.event === "browser_shopping_save" && event.outcome === "saved_refresh_failed" && event.acknowledged === true), "shopping refresh failure preserves acknowledged state");
  assert.equal(await browser("eval", "document.querySelector('.purchase-row input[type=checkbox]').checked"), "false");
  await browser("eval", "window.dispatchEvent(new ErrorEvent('error', {message:'PRIVATE-ERROR-NEVER-EXPORT', filename:'https://private.example/path'})); window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {promise:Promise.resolve(),reason:new Error('PRIVATE-REJECTION-NEVER-EXPORT')})); const start=performance.now();while(performance.now()-start<100){}; true");
  await browser("click", 'aside nav a[href="#recipes"]');
  await waitFor(() => events.some(event => event.event === "browser_error" && event.reason === "script_error") && events.some(event => event.event === "browser_error" && event.reason === "unhandled_rejection") && events.some(event => event.event === "browser_long_task"), "classified errors and real long-task observer delivered");
  await waitFor(() => events.some(event => event.event === "browser_vital" && event.metric === "FCP") && events.some(event => event.event === "browser_vital" && event.metric === "TTFB"), "real Web Vitals delivered");
  await browser("tab", "new", "--label", "background", "about:blank");
  await waitFor(() => ["LCP", "INP", "CLS"].every(metric => events.some(event => event.event === "browser_vital" && event.metric === metric)), "LCP/INP/CLS finalize and beacon on a real tab visibility change");
  await browser("tab", "t1");
  assert(!payloads.join("\n").includes(privateName));
  for (const secret of ["PRIVATE-ERROR-NEVER-EXPORT", "PRIVATE-REJECTION-NEVER-EXPORT", "PRIVATE-INVALID-HOUSEHOLD", "private.example", "disposable-browser-ingestion"]) assert(!payloads.join("\n").includes(secret));
  console.log("PASS no user content, error text, URLs or ingestion token in exported payloads");
  if (live) {
    await waitFor(() => acceptedEvents.some(event => event.event === "browser_mutation" && event.relatedOperationId === mutation.relatedOperationId) && acceptedEvents.some(event => event.event === "server_request" && event.traceId === request.relatedTraceId) && acceptedSpans.some(span => span.traceId === request.relatedTraceId && span.name === "PUT extras") && ["LCP", "INP", "CLS", "FCP", "TTFB"].every(metric => acceptedEvents.some(event => event.event === "browser_vital" && event.metric === metric)), "live Axiom accepted correlated browser/server events, all five Web Vitals and OTLP request spans");
    const root = acceptedSpans.find(span => span.traceId === request.relatedTraceId && span.name === "PUT extras")!;
    assert(acceptedSpans.some(span => span.traceId === root.traceId && span.parentSpanId === root.spanId && span.name === "api.operation"));
    assert(!deliveries.some(delivery => delivery.status < 200 || delivery.status >= 300 || delivery.rejected > 0), `Live Axiom delivery failed: ${JSON.stringify(deliveries)}`);
    console.log(JSON.stringify({ environment: "validation", version, region, eventsDataset, tracesDataset, acceptedEvents: acceptedEvents.length, acceptedSpans: acceptedSpans.length, operationId: mutation.relatedOperationId, traceId: request.relatedTraceId }));
  }
  // Fault/disabled phases remain local: do not manufacture outages or alter live Axiom resources.
  ingestionStatus = 503;
  await browser("open", `${url}/#shopping`);
  await browser("set", "viewport", "390", "844", "2");
  await browser("wait", ".extra-form");
  await submitExtra("Private ingestion outage success");
  await browser("wait", "--fn", "document.querySelector('.extra-form input').value === '' && document.querySelector('.extra-items').textContent.includes('Private ingestion outage success')");
  assert(await db.prepare("SELECT id FROM extras WHERE name='Private ingestion outage success'").first("id"));
  await waitFor(() => events.some(event => event.event === "browser_mutation" && event.device === "narrow" && event.outcome === "success"), "narrow-screen browser measurements exported during ingestion failure");
  console.log("PASS ingestion outage does not break UI saves or persisted state");
  ingestionEnabled = false;
  await browser("open", `${url}/#shopping`);
  await browser("wait", ".extra-form");
  const before = events.filter(event => String(event.event).startsWith("browser_")).length;
  await submitExtra("Private disabled telemetry success");
  await browser("wait", "--fn", "document.querySelector('.extra-form input').value === '' && document.querySelector('.extra-items').textContent.includes('Private disabled telemetry success')");
  await new Promise(resolve => setTimeout(resolve, 6000));
  assert.equal(events.filter(event => String(event.event).startsWith("browser_")).length, before);
  console.log("PASS disabled ingestion negotiation suppresses browser exports without blocking saves");
  console.log(`Telemetry browser E2E passed; household data was disposable; ingestion ${live ? "was live before local outage/disabled phases" : "receivers were disposable"}.`);
} finally {
  await browser("close");
  await new Promise<void>(resolve => server.close(() => resolve()));
  await worker.dispose();
}
