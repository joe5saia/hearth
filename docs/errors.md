# Error design

Adapted from [cf-workflow-pool error design](https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/errors.md)
for Hearth's React website, Effect household operations, and OAuth MCP Worker.

Errors are product interfaces and observability data. Help a household member or an
MCP caller understand the failure and recover without exposing private information.

## Messages and recovery

- Name the failed operation or outcome and the most specific safe reason known.
  Prefer “That recipe no longer exists. Refresh the recipes before editing.” over
  “Something went wrong.”
- Give a way forward: correct input, safely retry, inspect current state, or report
  the failure with its available request identifier. Do not invent a support service.
- Never recommend blindly retrying a write after a network or storage failure.
  A rejected D1 call or failed response does not prove that the write did not commit.
  Refresh/reconcile household state first; retrying a create may create a duplicate.
- Say “No recipes were updated” only when validation preceded writes or the atomic
  batch/guard proves it. Separate tool calls and write-then-refresh flows are not
  transactions. A refresh failure must not be presented as proof of a failed save.
- Use calm, direct household vocabulary: recipes, collections, groceries, meals,
  shopping lists, and timers. Avoid blame, jokes, SQL, stack traces, vendor response
  bodies, and internal storage or framework jargon in public messages.

## Typed internal failures and public boundaries

Shared operations use Effect tagged errors. Preserve known tags through inner
modules; translate each expected tag explicitly with `Effect.catchTag` or
`Effect.catchTags` at the website or MCP boundary. A defect fallback is allowed at
the outer boundary to keep unexpected failures private; it must record a classified
failure, not silently replace expected-error translation.

Use the existing contracts rather than introducing a second error framework:

- Household API failures retain `{ error: string }` and established statuses. The
  observation wrapper supplies `X-Hearth-Request-Id` for request correlation and
  `X-Hearth-Trace-Id` for tracing. Telemetry, assets, and authentication responses
  retain their existing formats.
- MCP tool failures retain `isError: true` and safe text content; successful tools
  return structured content and equivalent JSON text. HTTP response headers provide
  available request correlation. Do not invent error fields the SDK contract lacks.
- OAuth, Access, and MCP protocol rejection responses follow their owning protocol.
- Browser failures distinguish input rejection, unavailable reads, uncertain writes,
  and failed refreshes. Do not expose arbitrary exception text from dependencies.

Carry safe diagnostic facts in existing tagged errors, typed results, and telemetry:
operation, classified reason, known domain IDs where appropriate, and correlation.
Do not force operators to parse prose or add unrestricted public details records.
When extending an error contract, use literal codes and variant-specific fields;
update its schema and both transports deliberately. Preserve useful internal causes
without exporting them or logging household contents.

Never expose credentials, Access assertions, OAuth tokens, JWT claims, raw request
bodies, recipe text, SQL, stack traces, private causes, or raw vendor responses.
Use the telemetry allowlists and safe reason classifications in `src/observability.ts`
and `src/telemetry-contract.ts`.

## HTTP status semantics

For new endpoints, choose by caller-visible meaning: 400 invalid input, 401 missing
authentication, 403 forbidden access, 404 unknown resource, 405 unsupported method,
409 state conflict, 415 unsupported media type, 500 internal/storage failure, and
503 temporarily unavailable capability. Preserve existing endpoint and protocol
semantics during a behavior-preserving refactor; status changes require an explicit
contract change. Infrastructure can reject requests before Hearth handles them.

## Review checklist

1. Does the message identify the failure and its specific safe reason?
2. Can the caller correct, retry safely, reconcile, or report it?
3. Are reassurance, commit claims, and retryability provably true?
4. Are known errors translated explicitly and defects observed separately?
5. Is useful diagnostic context typed, searchable, and correlated where available?
6. Are both public output and logs free of secrets and private household content?
7. Do smoke/E2E checks exercise the failure through the real boundary?
