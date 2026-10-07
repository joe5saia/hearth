import { Context, Effect, Exit, Layer, Logger, Option, References, Schema, Scope, Tracer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

export interface TelemetryEnv {
  AXIOM_TOKEN?: string;
  AXIOM_TRACES_DATASET?: string;
  AXIOM_EVENTS_DATASET?: string;
  AXIOM_REGION?: string;
  TELEMETRY_ENVIRONMENT?: string;
  TELEMETRY_VERSION?: string;
  TELEMETRY_TRACE_SAMPLE_RATE?: string;
}

export type Fields = Record<string, string | number | boolean>;

// Only application-owned names and primitive measurements may cross the export boundary.
// In particular, never export Effect causes, SQL, KV keys, URLs, claims, bodies or error messages.
const fieldNames = new Set([
  "operation",
  "method",
  "status",
  "outcome",
  "reason",
  "durationMs",
  "traceId",
  "spanId",
  "requestId",
  "operationId",
  "service",
  "environment",
  "version",
  "sampleRate",
  "sampled",
  "recipes",
  "meals",
  "groceries",
  "ingredients",
  "bytes",
  "rowsRead",
  "rowsWritten",
  "sqlMs",
  "batchSize",
  "attempts",
  "changes",
  "model",
  "cacheHit",
  "attempted",
  "matched",
  "unmatched",
  "failed",
  "conflicts",
  "normalizationCalls",
  "selectionCalls",
  "normalizationCacheHits",
  "selectionCacheHits",
  "normalizationMs",
  "selectionMs",
  "retrievalMs",
  "totalMs",
  "candidates",
  "eventCount",
  "droppedSpans",
  "droppedEvents",
  "queueDepth",
  "queueMs",
  "writeMs",
  "refreshMs",
  "downloadMs",
  "decodeMs",
  "metric",
  "value",
  "page",
  "rating",
  "navigationType",
  "device",
  "initial",
  "acknowledged",
  "relatedOperationId",
  "relatedRequestId",
  "relatedTraceId",
]);

function safeFields(fields: Fields) {
  const safe: Fields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (fieldNames.has(key)) safe[key] = value;
  }

  return safe;
}

const nanos = () => BigInt(Date.now()) * 1_000_000n;

function axiomBase(env: TelemetryEnv) {
  const region = env.AXIOM_REGION === "eu-central-1" ? "eu-central-1" : "us-east-1";

  return `https://${region}.aws.edge.axiom.co`;
}

// Observe failures before the exporter's retry/shutdown deadline, and check OTLP partial success.
// Never log the response body, dependency error, request URL or authenticated headers.
const traceClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.tap((response) =>
        Effect.gen(function* () {
          if (response.status < 200 || response.status >= 300) {
            console.warn(
              JSON.stringify({ event: "telemetry_export_failed", signal: "traces", status: response.status }),
            );

            return;
          }

          const body = yield* response.json.pipe(Effect.catch(() => Effect.succeed(null)));

          const decoded = Schema.decodeUnknownOption(
            Schema.Struct({
              partialSuccess: Schema.Struct({
                rejectedSpans: Schema.optional(
                  Schema.Union([Schema.Number, Schema.String.check(Schema.isPattern(/^\d+$/))]),
                ),
              }),
            }),
          )(body);

          if (Option.isSome(decoded) && Number(decoded.value.partialSuccess.rejectedSpans ?? 0) > 0)
            console.warn(
              JSON.stringify({
                event: "telemetry_export_failed",
                signal: "traces",
                failed: Number(decoded.value.partialSuccess.rejectedSpans),
              }),
            );
        }),
      ),
      HttpClient.tapError(() =>
        Effect.sync(() =>
          console.warn(
            JSON.stringify({ event: "telemetry_export_failed", signal: "traces", reason: "transport_error" }),
          ),
        ),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

export class Observation {
  get traceId() {
    return this.root.traceId;
  }
  readonly requestId = crypto.randomUUID();
  readonly events: Fields[] = [];
  root: Tracer.Span;
  readonly started = performance.now();
  readonly sampleRate: number;
  readonly sampled: boolean;
  private spans = 0;
  private droppedSpans = 0;
  private droppedEvents = 0;

  constructor(
    readonly service: string,
    readonly env: TelemetryEnv,
    readonly operation: string,
    readonly method: string,
    readonly operationId: string,
  ) {
    const rate = Number(env.TELEMETRY_TRACE_SAMPLE_RATE ?? "1");
    this.sampleRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1;
    this.sampled = Math.random() < this.sampleRate;
    this.root = new Tracer.NativeSpan({
      name: `${method} ${operation}`,
      kind: "server",
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime: nanos(),
      sampled: this.sampled,
    });
    this.root.attribute("operation", operation);
    this.root.attribute("method", method);
  }

  event(event: string, fields: Fields = {}) {
    const limit =
      event === "server_request"
        ? 257
        : ["database_call", "model_call", "model_failure"].includes(event)
          ? 240
          : 256;

    if (this.events.length >= limit) {
      this.droppedEvents++;

      return;
    }

    this.events.push({
      operation: this.operation,
      ...safeFields(fields),
      _time: new Date().toISOString(),
      event,
      traceId: this.traceId,
      requestId: this.requestId,
      operationId: this.operationId,
      service: this.service,
      environment: this.env.TELEMETRY_ENVIRONMENT ?? "local",
      version: this.env.TELEMETRY_VERSION ?? "development",
    });
  }

  async tracer(scope: Scope.Closeable): Promise<Tracer.Tracer> {
    const configured = this.sampled && this.env.AXIOM_TOKEN && this.env.AXIOM_TRACES_DATASET;

    const backend = configured
      ? await Effect.runPromise(
          OtlpTracer.make({
            url: `${axiomBase(this.env)}/v1/traces`,
            headers: {
              Authorization: `Bearer ${this.env.AXIOM_TOKEN}`,
              "X-Axiom-Dataset": this.env.AXIOM_TRACES_DATASET!,
            },
            resource: {
              serviceName: this.service,
              serviceVersion: this.env.TELEMETRY_VERSION ?? "development",
              attributes: { "deployment.environment.name": this.env.TELEMETRY_ENVIRONMENT ?? "local" },
            },
            exportInterval: "1 hour",
            maxBatchSize: 10000,
            shutdownTimeout: "2 seconds",
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
            Effect.provide(
              Layer.mergeAll(
                OtlpExporter.layerFlusher,
                OtlpSerialization.layerJson,
                traceClient,
                Logger.layer([
                  Logger.make(() =>
                    console.warn(JSON.stringify({ event: "telemetry_export_failed", signal: "traces" })),
                  ),
                ]),
              ),
            ),
          ),
        )
      : Tracer.nativeTracer;

    return Tracer.make({
      span: (options) => {
        const span = backend.span({ ...options, sampled: this.sampled && this.spans++ < 256 });

        if (!span.sampled && this.sampled) this.droppedSpans++;
        const end = span.end.bind(span);
        span.end = (time, exit) =>
          end(time, Exit.isFailure(exit) ? Exit.fail("operation_failed") : Exit.void);
        const attribute = span.attribute.bind(span);
        span.attribute = (key, value) => {
          if (fieldNames.has(key)) attribute(key, value);
        };

        // Events can otherwise carry raw dependency errors; use classified outcome attributes instead.
        span.event = () => {};

        return span;
      },
    });
  }

  run<A, E>(effect: Effect.Effect<A, E>, tracer: Tracer.Tracer, signal?: AbortSignal) {
    return Effect.runPromise(
      effect.pipe(
        Effect.provideService(CurrentObservation, this),
        Effect.withTracer(tracer),
        Effect.withParentSpan(this.root),
      ),
      { signal },
    );
  }

  async step<A>(name: string, run: () => Promise<A>, tracer: Tracer.Tracer): Promise<A> {
    const span = tracer.span({
      name,
      kind: "internal",
      root: false,
      parent: Option.some(this.root),
      annotations: Context.empty(),
      links: [],
      startTime: nanos(),
      sampled: this.sampled,
    });

    try {
      const value = await run();
      span.end(nanos(), Exit.void);

      return value;
    } catch (error) {
      span.end(nanos(), Exit.fail("dependency_failure"));
      throw error;
    }
  }

  finish(status: number) {
    this.root.attribute("status", status);
    this.root.attribute("outcome", status >= 500 ? "error" : status >= 400 ? "rejected" : "success");
    this.root.end(nanos(), status >= 500 ? Exit.fail("request_failed") : Exit.void);
    this.event("server_request", {
      operation: this.operation,
      method: this.method,
      status,
      outcome: status >= 500 ? "error" : status >= 400 ? "rejected" : "success",
      durationMs: performance.now() - this.started,
      sampleRate: this.sampleRate,
      sampled: this.sampled,
      droppedSpans: this.droppedSpans,
      droppedEvents: this.droppedEvents,
    });
  }

  async exportEvents() {
    if (!this.env.AXIOM_TOKEN || !this.env.AXIOM_EVENTS_DATASET) return;

    try {
      const response = await fetch(
        `${axiomBase(this.env)}/v1/ingest/${encodeURIComponent(this.env.AXIOM_EVENTS_DATASET)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.env.AXIOM_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(this.events),
          signal: AbortSignal.timeout(2000),
        },
      );

      if (!response.ok)
        console.warn(
          JSON.stringify({ event: "telemetry_export_failed", signal: "events", status: response.status }),
        );
      else {
        const result = Schema.decodeUnknownSync(Schema.Struct({ failed: Schema.Number }))(
          await response.json(),
        );

        if (result.failed)
          console.warn(
            JSON.stringify({ event: "telemetry_export_failed", signal: "events", failed: result.failed }),
          );
      }

      if (!response.bodyUsed) await response.body?.cancel();
    } catch {
      console.warn(JSON.stringify({ event: "telemetry_export_failed", signal: "events" }));
    }
  }
}

export const CurrentObservation = Context.Reference<Observation | undefined>("hearth/Observation", {
  defaultValue: () => undefined,
});

export const record = Effect.fnUntraced(function* (event: string, fields: Fields) {
  const observation = yield* CurrentObservation;
  observation?.event(event, fields);
  yield* Effect.annotateCurrentSpan(fields);
});

export async function observedFetch(
  request: Request,
  env: TelemetryEnv,
  ctx: ExecutionContext | undefined,
  service: string,
  operation: string,
  run: (observation: Observation, tracer: Tracer.Tracer) => Promise<Response>,
) {
  const supplied = request.headers.get("X-Hearth-Operation-Id") ?? "";

  const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();

  const observation = new Observation(
    service,
    env,
    operation,
    ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(request.method)
      ? request.method
      : "OTHER",
    operationId,
  );

  const scope = await Effect.runPromise(Scope.make());
  let tracer: Tracer.Tracer;

  try {
    tracer = await observation.tracer(scope);
  } catch {
    tracer = Tracer.nativeTracer;
    console.warn(JSON.stringify({ event: "telemetry_setup_failed" }));
  }

  // Root IDs are application-generated, not trusted incoming trace context.
  observation.root = tracer.span({
    name: observation.root.name,
    kind: "server",
    root: true,
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    startTime: nanos(),
    sampled: observation.sampled,
  });
  observation.root.attribute("operation", operation);
  observation.root.attribute("method", observation.method);
  observation.root.attribute("requestId", observation.requestId);
  observation.root.attribute("operationId", observation.operationId);
  let status = 500;

  try {
    const response = await run(observation, tracer);
    status = response.status;
    const headers = new Headers(response.headers);
    headers.set("X-Hearth-Request-Id", observation.requestId);
    headers.set("X-Hearth-Trace-Id", observation.traceId);
    headers.set("X-Hearth-Telemetry", env.AXIOM_TOKEN && env.AXIOM_EVENTS_DATASET ? "1" : "0");

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    observation.finish(status);

    const flush = Promise.all([observation.exportEvents(), Effect.runPromise(Scope.close(scope, Exit.void))])
      .then(() => undefined)
      .catch(() => {
        console.warn(JSON.stringify({ event: "telemetry_export_failed", signal: "traces" }));
      });

    if (ctx) ctx.waitUntil(flush);
    else await flush;
  }
}
