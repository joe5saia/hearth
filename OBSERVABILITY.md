# Performance monitoring and tracing with Axiom

## Goal and rollout plan

Find regressions and scaling limits before users encounter them, and distinguish an app failure from a slow database, model, import, browser, or telemetry exporter. This app is still one shared household, not a multi-tenant service. Adding users alone does not increase household cardinality; recipe/photo growth and concurrent edits are separate load dimensions.

Roll out in this order:

1. **Server first:** instrument the website and MCP Workers, authentication/OAuth phases, D1 calls, stored-data decoding, household loading/encoding, MCP tools/search, recipe imports and ingredient matching. Implemented and validated with real local Worker/D1/KV behavior; website request/D1 traces have also been accepted and read back from live Axiom. Production deployment remains pending.
2. **Connect Axiom and establish a baseline:** verify a read, a disposable write, an application rejection, an OAuth flow, a matching run, and an import in an isolated environment. Website/browser exports are verified against the configured datasets; native Cloudflare, OAuth, model and import live coverage and a production baseline remain pending. Confirm parent/child waterfalls, region, version, privacy, and ingestion diagnostics. Separately approve live resource/configuration changes; never use production household data as a test fixture.
3. **Browser next:** measure user-perceived performance and correlate a UI action with its write and subsequent household read. Browser collection and built-SPA E2E are implemented, including live Axiom read-back of all five Web Vitals. Confirm real-user performance after deployment; local Chromium alone cannot establish production/mobile performance.
4. **Operationalize:** create dashboards, alerts and notification ownership; observe at least a week before tightening budgets. Review release-by-release changes, dependency failure rates, payload sizes and cost. The dashboard/alert specifications below are a plan, not already-provisioned Axiom resources.
5. **Before expanding access:** add independent uptime/export-health coverage and native Cloudflare resource metrics; run controlled concurrency/large-household load tests against an isolated Preview. Revisit single-household access, concurrent writes, inline images and full-household refreshes before assuming this design is multi-tenant-ready.

## What is measured

Measurements are structured events in `hearth-events`; request-scoped OTLP/HTTP traces are in `hearth-traces`. This intentionally reuses Effect's existing tracer rather than installing a second server SDK or automatically capturing SQL/URLs. Services are `hearth-web` and `hearth-mcp`. Both carry environment and release version.

| Area                 | Available measurements                                                                                                                                                 | Question answered                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Website/MCP requests | Counts, normalized operation/method, HTTP status, classified outcome, wall duration, trace sampling rate, dropped event/span counts                                    | Which route or release is slower or failing?                            |
| Access/OAuth         | `auth.access`, `oauth.dispatch`, `oauth.consent` spans; classified auth/OAuth failures                                                                                 | Is sign-in/token handling the bottleneck?                               |
| D1                   | `database_call` duration/outcome; batch size, rows read/written, changes, SQL duration and attempts when D1 returns metadata; `db.call` spans                          | Are scans, writes, retries or database latency growing?                 |
| Stored data          | `storage.decode` spans and `StoredDataError` classification                                                                                                            | Is stored JSON invalid, or is decoding expensive?                       |
| Household            | `household.load`, recipe/meal/grocery cardinality; `household_response` serialized UTF-8 bytes and encoding duration                                                   | Are full snapshots/inline photos becoming too large?                    |
| MCP tools            | Named `mcp.<tool>` spans, per-tool duration/success/error, failure category                                                                                            | Did a tool fail despite transport HTTP 200?                             |
| MCP search           | Recipes inspected/returned and query operation timing, without query text                                                                                              | Is in-memory recipe scanning scaling poorly?                            |
| Recipe import        | `recipe.import` and `import.download_parse` spans, completion ingredient count, classified failures                                                                    | Is upstream download/parse slow or unreliable?                          |
| Matching             | Run and ingredient spans; attempted/matched/unmatched/failed/conflict counts; normalization, selection, retrieval and total durations; cache-hit and model-call counts | Are model calls, cache misses or concurrent edits the limiting factor?  |
| Models               | `ai.model` spans; `model_call`/`model_failure` wall duration, model identifier and fixed failure reason                                                                | Which model is slow, timing out or returning unusable results?          |
| Browser requests     | Normalized operation/method, status, network failure and response-header latency                                                                                       | What does the browser see versus the server?                            |
| Browser household    | UTF-8 payload bytes, download time, JSON/schema decode time, cardinality, initial navigation-to-next-paint or refresh-to-next-paint duration                           | Is loading slow because of transport, data size, decoding or readiness? |
| Browser saves        | End-to-end mutation duration and acknowledgement; shopping queue depth/wait, write and refresh durations                                                               | Did a write fail, or was it saved but the refresh failed?               |
| Browser rendering    | LCP, INP, CLS, FCP, TTFB, rating/navigation type; supported long-task durations; route commit-to-next-paint approximation                                              | Does the app feel fast and stable?                                      |
| Browser errors       | Script/resource, unhandled rejection, uncaught/recoverable React render and household decode categories                                                                | Are users encountering client failures?                                 |

For shopping edits, `success`, `error` with `acknowledged=false`, and `saved_refresh_failed` with `acknowledged=true` are distinct. A skipped refresh on a superseded queued edit is not a failed refresh. Matching can be HTTP 200 with partial model failures/conflicts; use `matching_completed` counts/outcome, not just status. An import is a draft operation, not a persisted recipe write.

### Important measurement boundaries

- Server duration ends when the Worker produces a Response, not when a streamed body reaches the user. Browser request latency ends at response headers; household download duration includes body consumption. Payload bytes are decoded UTF-8 JSON size, not compressed wire bytes.
- Double `requestAnimationFrame` approximates readiness/next paint. Route timing starts after React commits; it is not full click-to-paint timing or a soft-navigation Core Web Vital. Use INP for real interaction responsiveness.
- `web-vitals` emits finalized values when its lifecycle conditions are met. INP needs interaction; some metrics finalize when the page hides. Unsupported metrics/long-task observers simply do not produce measurements. Compare p75 by metric, device and release, not mixed units; CLS is unitless, other vitals are milliseconds.
- Browser data is **correlated events**, not a browser OTLP span tree. Each API request has an independently generated server trace. `X-Hearth-Operation-Id` groups the write/read workflow; response request/trace IDs appear as `relatedRequestId`/`relatedTraceId` in browser events. Axiom OTLP trace fields use `trace_id`/`span_id`, while structured event fields use `traceId`/`requestId`. Correlation IDs are not user identity or authorization evidence. Incoming `traceparent`/baggage are not trusted or propagated to third parties.
- D1 `.first()` discards result metadata: those calls have wall duration, not rows-read/SQL-time measurements. KV calls inside the OAuth library are covered by provider-phase timing, not individual KV spans. Import download and parse currently share one span.
- Cloudflare clocks can remain fixed during CPU-only work. Do not infer CPU usage or zero CPU cost from a zero-duration Worker span. In-process telemetry cannot observe isolate crashes, CPU/memory-limit termination, failed starts, or requests rejected by Access before reaching the Worker.

## Axiom configuration and secrets

1. Create **two Events datasets** (not Metrics datasets): `hearth-events` for structured events and `hearth-traces` exclusively for OTLP traces. Pick the same edge deployment for both. Prefer separate disposable datasets/token for live validation; explicitly authorized sample exports into these datasets must use the `validation` environment, never `production`. Local development never ingests by default. The configured datasets have been confirmed as Events datasets in `us-east-1`.
2. Create an **API token with ingest-only permission on these datasets**. A personal access token is not supported for event ingestion. Do not grant query/admin rights to the Worker token. Querying/provisioning dashboards requires a separate user or credential with the appropriate permissions.
3. Add `AXIOM_API_TOKEN` as a secret in GitHub's **production environment**. The workflow maps it to the existing `AXIOM_TOKEN` deployment environment variable and Worker secret binding. Amp/local validation continues to use `AXIOM_TOKEN`. Optionally add these nonsecret variables:

   | Variable                      | Default / meaning                               |
   | ----------------------------- | ----------------------------------------------- |
   | `AXIOM_EVENTS_DATASET`        | `hearth-events`                                 |
   | `AXIOM_TRACES_DATASET`        | `hearth-traces`                                 |
   | `AXIOM_REGION`                | `us-east-1`; use `eu-central-1` for EU datasets |
   | `TELEMETRY_TRACE_SAMPLE_RATE` | `1` initially; probability from `0` to `1`      |

   Local production deployment uses the same environment variables; Alchemy binds the token as a redacted Worker secret, never a `VITE_` variable. `TELEMETRY_ENVIRONMENT` is `production`; release version comes from `GITHUB_SHA`, otherwise `TELEMETRY_VERSION` or `unversioned`. The default local website bindings deliberately omit ingestion credentials. Existing Preview tools do not automatically copy this token into Preview deployments.

4. Deployment still needs the normal shipping/deployment authorization. Adding credentials does not authorize manually triggering a deployment. Do not paste the token into chat, source, Task arguments, logs or screenshots; enter it through GitHub/Amp secret settings.
5. After deployment, verify both event and trace arrivals. Axiom region selection is dataset-specific: a correct token with a wrong region/dataset is still a configuration error. Recognized regions select a fixed allowlisted host; an unknown region currently falls back to US, so check the variable carefully.

Endpoints are `https://<region>.aws.edge.axiom.co/v1/ingest/<dataset>` for events and `/v1/traces` for OTLP. Both use Bearer authentication; traces also use `X-Axiom-Dataset`. No token or arbitrary remote destination is accepted from the browser.

References: [Axiom OTLP](https://axiom.co/docs/send-data/opentelemetry), [event ingest](https://axiom.co/docs/restapi/ingest), [regions](https://axiom.co/docs/reference/edge-deployments), [trace explorer](https://axiom.co/docs/query-data/traces).

## Privacy, delivery and cost controls

- Only application-owned attribute names and primitive measurements are exported. Never export email/subject IDs, cookies, JWTs/OAuth codes, headers, IPs, SQL or bind values, request/response bodies, ingredient/recipe/grocery names, notes, query strings, URLs, AI prompts/output, error messages or stack traces. Span failures are replaced with fixed generic errors. Browser ingestion rejects extra fields and validates every string against a finite enum or correlation-ID pattern.
- The browser calls authenticated, same-origin `POST /api/telemetry`; it does not contact Axiom. The endpoint checks Access, JSON content type, Origin, a streamed 16 KiB body limit, and 1–20 events per batch. It accepts no D1 writes. Its 120-batch/minute limit is **per isolate, shared by users**, not a global or per-user quota. Add platform-level abuse protection before opening access broadly; rejected requests still have request telemetry.
- Browser queue: maximum 80 events, up to 20 per five-second batch, best-effort beacon/keepalive on visibility changes, two-second fetch timeout, no indefinite retries. Disabled ingestion is negotiated on API responses and suppresses browser exports. Blocking ingestion cannot block a business save. Startup/network failures before negotiation and queued/dropped/unload events can be lost; this is not an audit log.
- Worker traces/events are buffered per request and exported in `waitUntil`, not awaited on the response path. Trace shutdown/event requests have a two-second bound. No durable queues or automatic application-write retries are introduced. Missing token disables export. Request buffers allow at most 256 sampled spans and 257 events, reserving capacity for summaries; detailed D1/model events stop earlier. Dropped counts appear in the request summary.
- Traces use random **head sampling**. Start at 100% for this small app; reduce to 10–20% after baselining if volume warrants it. Request outcome events are not sampled, although caps/export failures can still lose data. Unsampled error traces are not recovered by tail sampling. Do not derive exact request/error rates from the sampled trace dataset or estimate p99 from tiny samples.
- `telemetry_setup_failed` and `telemetry_export_failed` are safe Worker console diagnostics, not guaranteed Axiom events. Event and trace export check HTTP failures and HTTP-200 partial ingestion failures. When Axiom is unavailable, use Cloudflare logs/independent monitoring rather than relying on Axiom to report its own outage.
- Server export currently uses up to two ingestion requests per application request; browser batching amortizes client collection but detailed database events remain unsampled within caps. Review ingested bytes/event counts weekly and after releases. Start with 14 days of traces and 30 days of events, adjusted to plan/budget/compliance; keep longer rollups only if needed. No retention or billing configuration has been changed automatically.

## Dashboards to create

Use a production environment filter everywhere; add release, service, operation and device selectors. Exclude `assets`, `telemetry` and `unknown` from business API SLIs, and keep separate panels for authentication/transport rejections. Low-cardinality dimensions are operation, method, status, reason, model, page, device, version. Do not group aggregate charts by request/trace/operation UUIDs.

1. **Service health:** request volume, 5xx/error rate, expected 4xx separately, p50/p95/p99 per route/service, slowest traces and release comparisons; MCP tool failures alongside HTTP status.
2. **Database and payload scale:** D1 call latency/errors, rows-read versus household cardinality, rows-written/retry attempts, encoding/decode time, household byte size, and write→full-refresh amplification. Distinguish metadata-bearing calls from `.first()`.
3. **Matching/import dependencies:** model latency/failure reasons, cache-hit ratios using summary counts, matching total time/completion quality/conflicts, model calls per run, import rejection/latency. Correlate sustained model-call growth with Cloudflare billing.
4. **Real user experience:** p75 Web Vitals by device/release, initial household readiness, refresh download/decode times, save duration, queue wait/depth, saved-but-refresh-failed rate, long tasks and browser errors by page/category.
5. **Telemetry coverage/cost:** dataset ingress volume, sampled rate, dropped event/span counts, missing release versions and arrival gaps. Add independent exporter-health/native Worker log coverage before relying on this for paging.

### Starter APL queries

These use the default dataset names. Change them to your configured names. Request, database, browser-vital, save and trace queries have been executed against live validation data; MCP/matching queries still need live coverage. Production filters intentionally exclude validation traffic.

```apl
['hearth-events']
| where environment == 'production' and event == 'server_request'
| where operation !in ('assets', 'telemetry', 'unknown')
| summarize requests=count(), failures=countif(status >= 500),
    p50=percentile(durationMs, 50), p95=percentile(durationMs, 95), p99=percentile(durationMs, 99)
    by bin(_time, 5m), service, operation, method
| extend errorPercent=100.0 * failures / requests
```

```apl
['hearth-events']
| where environment == 'production' and event == 'mcp_tool'
| summarize calls=count(), failures=countif(outcome == 'error'), p95=percentile(durationMs, 95)
    by bin(_time, 5m), operation
```

```apl
['hearth-events']
| where environment == 'production' and event == 'database_call'
| summarize calls=count(), failures=countif(outcome == 'error'), p95=percentile(durationMs, 95),
    rowsRead=sum(rowsRead), rowsWritten=sum(rowsWritten), attempts=sum(attempts)
    by bin(_time, 5m), service
```

```apl
['hearth-events']
| where environment == 'production' and event == 'matching_completed'
| summarize runs=count(), p95=percentile(totalMs, 95), failures=sum(failed), conflicts=sum(conflicts),
    normalizationCalls=sum(normalizationCalls), normalizationHits=sum(normalizationCacheHits),
    selectionCalls=sum(selectionCalls), selectionHits=sum(selectionCacheHits)
    by bin(_time, 1h)
```

```apl
['hearth-events']
| where environment == 'production' and event == 'browser_vital'
| summarize samples=count(), p75=percentile(value, 75) by metric, device, version
```

```apl
['hearth-events']
| where environment == 'production' and event in ('browser_mutation', 'browser_shopping_save')
| summarize saves=count(), failedWrites=countif(outcome == 'error' and acknowledged == false),
    failedRefreshes=countif(outcome == 'saved_refresh_failed'), p95=percentile(durationMs, 95)
    by bin(_time, 15m), event, operation, device
```

For a failing browser workflow, filter events by `operationId == '<UUID>' or relatedOperationId == '<UUID>'`; use its server `traceId` or browser `relatedTraceId` to open the trace waterfall. For direct OTLP inspection:

```apl
['hearth-traces']
| where trace_id == '<TRACE_ID>'
| project _time, name, span_id, parent_span_id, duration, ['attributes.custom'], ['status.code']
```

## Initial budgets, alerts and response playbook

These are **proposed targets**, not measured production guarantees. Recalibrate after the baseline. Owner: application maintainer; route notifications to a tested operational channel and document its backup owner before paging.

| Signal                          | Initial target / alert                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business API availability       | 99.5% over 28 days; exclude expected validation/auth rejections and telemetry/assets. Alert on ≥5 unexpected failures and >2% failures in 10 minutes; use absolute counts at the current small traffic level.                                 |
| Household read / ordinary write | p95 <500 ms Worker wall time; warn on p95 >1 second for 15 minutes with ≥20 samples. Separate model/import work.                                                                                                                              |
| MCP application success         | ≥99.5% excluding expected invalid-input/not-found/conflict outcomes. Initially inspect `mcp_tool_failure.reason` rather than counting all tool rejections as outages.                                                                         |
| Matching/import                 | Matching p95 <15 seconds for the baseline household; import p95 <10 seconds. Alert on repeated timeouts/dependency failures; model failures/conflicts may be partial successes. Existing model/import timeouts are not SLOs.                  |
| Core Web Vitals                 | p75 LCP ≤2.5 seconds, INP ≤200 ms, CLS ≤0.1 by device; review daily with ≥50 samples before alerting. FCP ≤1.8 seconds and TTFB ≤800 ms are diagnostic targets.                                                                               |
| Household readiness / saves     | Initial browser readiness p75 <3 seconds; ordinary save+refresh p95 <1.5 seconds. Warn on ≥3 saved-but-refresh-failed outcomes in 15 minutes; inspect any repeatable failed write.                                                            |
| Payload / queue growth          | Warn when household p95 >1 MiB or doubles against a seven-day baseline; queue-wait p95 >500 ms or repeated queue depth >3. Inline photos can already breach the payload target: treat this as prioritization evidence, not a surprise outage. |
| Telemetry                       | Investigate any dropped spans/events or export failures; alert on missing expected synthetic telemetry rather than silence during legitimately idle household traffic. Track Axiom usage against an explicit monthly budget.                  |

For higher traffic, use short/long-window error-budget burn alerts rather than one noisy threshold. Do not page on an isolated percentile with insufficient samples.

Triage in order:

1. Check environment/version, missing telemetry and recent release changes. Verify Cloudflare service health if Axiom is silent.
2. Pick a representative failed/slow operation UUID and trace; separate auth, transport, app validation/conflict, D1, AI/import and browser failures.
3. For D1 latency, compare rows read and household cardinality before proposing indexes/pagination. For large payloads, prioritize serving photos separately and narrower refreshes. For model latency/cost, compare cache hits and calls before increasing concurrency.
4. If a write acknowledgement exists, read durable state before retrying. A failed response/connection does not prove a write did not commit; never blindly retry a non-idempotent operation.
5. If ingestion fails, inspect safe exporter logs, dataset permissions, region and sampling configuration. Removing the token disables ingestion but requires a separately authorized deployment; do not disable Access or expose the token as a workaround. Application persistence must continue working during an Axiom outage.

## Validation and remaining infrastructure work

```sh
npx task check
npx task telemetry:smoke
npx task benchmark -- /tmp/hearth-telemetry-performance.json
```

The integration suite uses actual bundled Workers, disposable D1/KV, signed JWT/OAuth flows and outbound ingestion wire receivers. It verifies request/API/household/D1 parentage, privacy, unsampled outcomes, ingestion failure/disabled behavior, browser input limits, Access/Origin checks, MCP HTTP-200 tool failures, corrupted stored-data and D1 failures. The built-SPA Chromium smoke exercises successful/rejected/network-failed saves, invalid household decoding, optimistic shopping acknowledgement/rollback/refresh failure, wide/narrow classifications, Web Vitals, long tasks, classified errors, correlation and ingestion-outage isolation. It is browser emulation, not physical mobile-device testing. By default ingestion stays local; live Axiom validation requires the explicit option below.

### Explicit live-ingestion validation

With authorization to send sample telemetry and `AXIOM_TOKEN` supplied through secure secret settings:

```sh
npx task telemetry:smoke -- --live
```

This keeps the built SPA and disposable Worker/D1 local, but forwards their actual privacy-checked exports to Axiom using `AXIOM_REGION`, `AXIOM_EVENTS_DATASET` and `AXIOM_TRACES_DATASET` (defaults above). It tags every export `environment=validation` with a unique `validation-<UUID>` version. Successful ingestion responses/counts and parentage are checked; simulated ingestion-outage/disabled phases remain local. It creates no Cloudflare resources or dashboards and never touches production D1. Validation telemetry remains in Axiom until normal retention expiry. Read-back requires a separately authorized query connection, not additional permissions on the ingestion token.

On 2026-10-06, the live task passed and Axiom queries independently confirmed **80 events and 52 spans** for `validation-7dd397d6-48e7-46f2-9591-a70f00f40fed`: request/D1 events, browser save/refresh/error classifications, all five Web Vitals, and `PUT extras` → `api.operation` → `db.call` parentage. Trace `81308d4021c4755dc06964c7710dadac` correlates with operation `64401b2d-d134-4d7f-a901-6915dedfa475`. This proves application export/ingestion/read-back compatibility, not production Worker networking, real-user latency or alert delivery. The Amp project secret is available to authorized orb work; it does **not** automatically populate GitHub's production environment secret.

The benchmark compares disabled export with 100% traces/events sent to a disposable local ingestion receiver for normal, large and inline-photo household fixtures. It measures response-body/JSON consumption, not real Axiom network overhead, production cold starts or authentication. Use repeated runs on the same idle machine; there are no hardware-dependent pass/fail timing thresholds.

Before broad access, separately implement/validate:

- Native Cloudflare Worker CPU, wall-time, memory/limit failures, isolate/request counts and pre-Worker Access failures; D1 storage/rows/quota and KV operation/error coverage; Workers AI usage/tokens/billing. These are not produced by the application event exporter, and model-call counts are not a billing-grade token/cost metric.
- Privacy-reviewed Cloudflare logs/native export or an independent monitor for exporter failure and platform termination. Do not enable raw request/SQL/KV-key export without reviewing actual output for OAuth/user-data leakage.
- An authenticated, read-only synthetic household probe from outside Cloudflare at a modest cadence, with a separate read-only identity and alerts for consecutive failures and missing expected telemetry. Do not turn monitoring into production mutations.
- Controlled concurrent reads/writes, growing recipe/meal/photo fixtures and model/import dependencies in an isolated Preview; capture p95/p99, errors, rows, payload sizes and cost. Compare against baseline and find the first limiting resource. Teardown disposable resources after agent-only checks.
- Global/per-user abuse limits appropriate to the future access/tenancy model, browser-drop observability if losses matter, and a durable collector/batch pipeline if telemetry volume or delivery guarantees require one.
- Live native Cloudflare export coverage, MCP/matching/import queries, partial-ingest behavior, dashboard provisioning, alert delivery and retention/cost settings. Creating an ingest-only token does not itself provision any dashboards or monitors.
