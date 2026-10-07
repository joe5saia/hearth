import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions, type V4WorkerdStructuredLog } from "miniflare";
import { rolldown } from "rolldown";
import { readFile, readdir } from "node:fs/promises";
import { Schema } from "effect";

const Event = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));

const Attribute = Schema.Struct({ key: Schema.String, value: Schema.Unknown });

const Span = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Array(Attribute),
  status: Schema.Struct({ code: Schema.Number }),
});

const Payload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({ scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Span) })) }),
  ),
});

let worker: Miniflare;

let script: string;

const events: (typeof Event.Type)[] = [];

const traces: (typeof Span.Type)[] = [];

const payloads: string[] = [];

const logs: V4WorkerdStructuredLog[] = [];

let ingestionStatus = 200;

let partialFailure = false;

function options(sampleRate = "1", token = "disposable-ingestion-fixture") {
  return convertV4MiniflareOptions({
    handleStructuredLogs: (log) => logs.push(log),
    workers: [
      {
        name: "observability-smoke",
        modules: true,
        script,
        compatibilityDate: "2026-09-08",
        d1Databases: ["DB"],
        bindings: {
          LOCAL_DEV: "true",
          AXIOM_TOKEN: token,
          AXIOM_TRACES_DATASET: "smoke-traces",
          AXIOM_EVENTS_DATASET: "smoke-events",
          TELEMETRY_ENVIRONMENT: "smoke",
          TELEMETRY_VERSION: "smoke-version",
          TELEMETRY_TRACE_SAMPLE_RATE: sampleRate,
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          expect(["api.axiom.co", "us-east-1.aws.edge.axiom.co"]).toContain(url.hostname);
          expect(request.headers.get("Authorization")).toBe("Bearer disposable-ingestion-fixture");
          const body = await request.text();
          payloads.push(body);

          if (url.pathname === "/v1/traces") {
            const parsed = Schema.decodeUnknownSync(Payload)(JSON.parse(body));
            traces.push(...parsed.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
          } else {
            expect(url.pathname).toBe("/v1/ingest/smoke-events");
            events.push(...Schema.decodeUnknownSync(Schema.Array(Event))(JSON.parse(body)));
          }

          return Response.json(
            partialFailure
              ? {
                  failed: 1,
                  failures: [{ error: "PRIVATE-INGEST-ERROR-NEVER-LOG" }],
                  partialSuccess: { rejectedSpans: "1", errorMessage: "PRIVATE-INGEST-ERROR-NEVER-LOG" },
                }
              : { ingested: 1, failed: 0 },
            { status: ingestionStatus },
          );
        },
      },
    ],
  });
}

beforeAll(async () => {
  const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
  const output = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Missing Worker bundle");
  script = entry.code;
  worker = new Miniflare(options());
  const db = await worker.getD1Database("DB");

  for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql
        .split(/;\n(?=CREATE|INSERT|DROP|ALTER)|;\s*$/)
        .filter((statement) => statement.trim())
        .map((statement) => db.prepare(statement)),
    );
  }
}, 30000);

afterAll(async () => worker?.dispose());

it("exports correlated request, D1 and decode spans without household content", async () => {
  const secret = "PRIVATE-RECIPE-CONTENT-NEVER-EXPORT-🍋";
  const operationId = crypto.randomUUID();

  const saved = await worker.dispatchFetch("https://hearth.test/api/recipes", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Hearth-Operation-Id": operationId,
      Cookie: "PRIVATE-COOKIE-NEVER-EXPORT",
    },
    body: JSON.stringify({
      id: "private-recipe",
      title: secret,
      description: secret,
      servings: 2,
      minutes: 15,
      category: "",
      source: "",
      photo: "",
      ingredients: [{ name: secret, quantity: 1, unit: "each" }],
      instructions: [secret],
      rating: "neutral",
    }),
  });

  expect(saved.status).toBe(200);
  const response = await worker.dispatchFetch("https://hearth.test/api/household?private=" + secret);
  expect(response.status).toBe(200);
  const requestId = response.headers.get("X-Hearth-Request-Id");
  const traceId = response.headers.get("X-Hearth-Trace-Id");
  const body = await response.text();
  expect(traceId).toMatch(/^[a-f0-9]{32}$/);
  await expect
    .poll(() => events.some((e) => e.event === "server_request" && e.requestId === requestId))
    .toBe(true);
  await expect.poll(() => traces.some((s) => s.traceId === traceId && s.name === "GET household")).toBe(true);
  const requestSpans = traces.filter((s) => s.traceId === traceId);
  const root = requestSpans.find((s) => s.name === "GET household")!;
  expect(root.parentSpanId).toBeUndefined();
  const api = requestSpans.find((s) => s.name === "api.operation")!;
  expect(api.parentSpanId).toBe(root.spanId);
  const household = requestSpans.find((s) => s.name === "household.load")!;
  expect(household.parentSpanId).toBe(api.spanId);
  expect(requestSpans.find((s) => s.name === "db.call")?.parentSpanId).toBe(household.spanId);
  expect(events.find((e) => e.requestId === requestId && e.event === "database_call")).toMatchObject({
    operation: "household",
    batchSize: 7,
    rowsWritten: 0,
  });
  expect(events.find((e) => e.requestId === requestId && e.event === "household_response")).toMatchObject({
    bytes: Buffer.byteLength(body, "utf8"),
  });
  expect(events.find((e) => e.requestId === requestId && e.event === "household_snapshot")).toMatchObject({
    recipes: 1,
    meals: 0,
  });
  expect(events.find((e) => e.operationId === operationId && e.event === "server_request")).toMatchObject({
    status: 200,
    operation: "recipes",
    environment: "smoke",
    version: "smoke-version",
  });
  expect(payloads.join("\n")).not.toContain(secret);
  expect(payloads.join("\n")).not.toContain("PRIVATE-COOKIE-NEVER-EXPORT");
  expect(payloads.join("\n")).not.toContain("SELECT");
  expect(payloads.join("\n")).not.toContain("disposable-ingestion-fixture");
});

it("classifies mapped application failures and preserves unsampled request counts", async () => {
  await worker.setOptions(options("0"));

  const response = await worker.dispatchFetch("https://hearth.test/api/recipes/private-id-never-export", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });

  expect(response.status).toBe(409);
  const requestId = response.headers.get("X-Hearth-Request-Id");
  await expect
    .poll(() => events.some((e) => e.requestId === requestId && e.event === "server_request"))
    .toBe(true);
  expect(events.find((e) => e.requestId === requestId && e.event === "api_failure")).toMatchObject({
    reason: "Conflict",
  });
  expect(events.find((e) => e.requestId === requestId && e.event === "server_request")).toMatchObject({
    status: 409,
    sampleRate: 0,
    sampled: false,
    outcome: "rejected",
  });
  expect(traces.some((s) => s.traceId === response.headers.get("X-Hearth-Trace-Id"))).toBe(false);
  expect(payloads.join("\n")).not.toContain("private-id-never-export");
});

it("keeps D1 persistence working when ingestion fails and when credentials are absent", async () => {
  ingestionStatus = 503;
  await worker.setOptions(options());

  const response = await worker.dispatchFetch("https://hearth.test/api/extras", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "outage-extra", name: "Private outage item", checked: 0 }),
  });

  expect(response.status).toBe(200);
  expect(
    await (
      await worker.getD1Database("DB")
    )
      .prepare("SELECT name FROM extras WHERE id='outage-extra'")
      .first("name"),
  ).toBe("Private outage item");
  await expect
    .poll(() =>
      events.some(
        (e) => e.requestId === response.headers.get("X-Hearth-Request-Id") && e.event === "server_request",
      ),
    )
    .toBe(true);
  ingestionStatus = 200;
  await worker.setOptions(options("1", ""));
  const before = payloads.length;
  const read = await worker.dispatchFetch("https://hearth.test/api/household");
  expect(read.status).toBe(200);
  await read.text();
  expect(payloads).toHaveLength(before);
}, 15000);

it("accepts bounded browser measurements but rejects private fields, oversized batches and cross-origin submissions", async () => {
  await worker.setOptions(options("0"));
  const relatedOperationId = crypto.randomUUID();

  const submit = (body: string, origin = "https://hearth.test") =>
    worker.dispatchFetch("https://hearth.test/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body,
    });

  const event = {
    event: "browser_vital",
    page: "shopping",
    device: "narrow",
    metric: "CLS",
    value: 0.23,
    rating: "needs-improvement",
    relatedOperationId,
  };

  expect((await submit(JSON.stringify([event]))).status).toBe(204);
  await expect.poll(() => events.some((item) => item.relatedOperationId === relatedOperationId)).toBe(true);
  expect(events.find((item) => item.relatedOperationId === relatedOperationId)).toMatchObject({
    event: "browser_vital",
    value: 0.23,
  });
  expect(
    (
      await submit(
        JSON.stringify([
          {
            event: "browser_household",
            page: "shopping",
            device: "wide",
            durationMs: 700000,
            bytes: 12000000,
          },
        ]),
      )
    ).status,
  ).toBe(204);
  expect((await submit(JSON.stringify([{ ...event, durationMs: -1 }]))).status).toBe(400);
  expect((await submit(JSON.stringify([{ ...event, bytes: 1.5 }]))).status).toBe(400);
  const secret = "PRIVATE-CLIENT-ERROR-NEVER-EXPORT";
  expect((await submit(JSON.stringify([{ ...event, message: secret }]))).status).toBe(400);
  expect((await submit(JSON.stringify([{ ...event, relatedTraceId: secret }]))).status).toBe(400);
  expect((await submit(JSON.stringify(Array.from({ length: 21 }, () => event)))).status).toBe(400);
  expect((await submit(" ".repeat(16385))).status).toBe(413);
  expect((await submit(JSON.stringify([event]), "https://untrusted.example")).status).toBe(403);
  expect((await submit(JSON.stringify([event]), "")).status).toBe(403);
  expect(payloads.join("\n")).not.toContain(secret);
});

it("reports HTTP and partial ingestion failures safely without failing household reads", async () => {
  await worker.setOptions(options());

  try {
    for (const status of [401, 429, 503]) {
      const before = logs.length;
      ingestionStatus = status;
      const response = await worker.dispatchFetch("https://hearth.test/api/household");
      expect(response.status).toBe(200);
      await response.text();
      await expect
        .poll(() =>
          logs
            .slice(before)
            .some(
              (log) =>
                log.message.includes('"signal":"traces"') && log.message.includes(`"status":${status}`),
            ),
        )
        .toBe(true);
    }

    ingestionStatus = 200;
    partialFailure = true;
    const before = logs.length;
    const response = await worker.dispatchFetch("https://hearth.test/api/household");
    expect(response.status).toBe(200);
    await response.text();

    for (const signal of ["events", "traces"])
      await expect
        .poll(() =>
          logs
            .slice(before)
            .some(
              (log) => log.message.includes(`"signal":"${signal}"`) && log.message.includes('"failed":1'),
            ),
        )
        .toBe(true);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE-INGEST-ERROR-NEVER-LOG");
    expect(JSON.stringify(logs)).not.toContain("disposable-ingestion-fixture");
  } finally {
    ingestionStatus = 200;
    partialFailure = false;
  }
}, 15000);

it("records D1 failure duration without SQL or stored private data", async () => {
  const db = await worker.getD1Database("DB");
  await db
    .prepare("UPDATE recipes SET ingredients=? WHERE id='private-recipe'")
    .bind(JSON.stringify([{ name: "PRIVATE-CORRUPT-DATA", quantity: -3, unit: "each" }]))
    .run();
  const invalid = await worker.dispatchFetch("https://hearth.test/api/household");
  expect(invalid.status).toBe(500);
  const id = invalid.headers.get("X-Hearth-Request-Id");
  await expect
    .poll(() => events.some((item) => item.requestId === id && item.reason === "StoredDataError"))
    .toBe(true);
  await db.prepare("DROP TABLE extras").run();

  const failed = await worker.dispatchFetch("https://hearth.test/api/extras", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "failure", name: "Private content", checked: 0 }),
  });

  expect(failed.status).toBe(500);
  const requestId = failed.headers.get("X-Hearth-Request-Id");
  await expect
    .poll(() =>
      events.some(
        (item) => item.requestId === requestId && item.event === "database_call" && item.outcome === "error",
      ),
    )
    .toBe(true);
  expect(
    events.find((item) => item.requestId === requestId && item.event === "database_call")?.durationMs,
  ).toBeGreaterThanOrEqual(0);
  expect(payloads.join("\n")).not.toContain("PRIVATE-CORRUPT-DATA");
  expect(payloads.join("\n")).not.toContain("INSERT INTO");
});

it("bounds browser batch volume within an isolate and returns retry guidance", async () => {
  const remaining = 60000 - (Date.now() % 60000);

  // Avoid crossing the real fixed-window boundary during the burst; no mocked clocks.
  if (remaining < 5000) await new Promise((resolve) => setTimeout(resolve, remaining + 50));
  const limited = new Miniflare(options("0"));

  try {
    const body = JSON.stringify([
      { event: "browser_navigation", page: "plan", device: "wide", durationMs: 12 },
    ]);

    for (let batch = 0; batch < 120; batch++) {
      const response = await limited.dispatchFetch("https://hearth.test/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://hearth.test" },
        body,
      });

      expect(response.status).toBe(204);
    }

    const rejected = await limited.dispatchFetch("https://hearth.test/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hearth.test" },
      body,
    });

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
  } finally {
    await limited.dispose();
  }
}, 15000);
