# Coding standards

Adapted from [cf-workflow-pool coding standards](https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/coding-standards.md)
for Hearth's TypeScript, React, Effect, D1, and Cloudflare Workers architecture.
The source project's monorepo, Effect HTTP API/OpenAPI generation, Option-only
representation, and Durable Object service conventions do not apply to this app.

## Ownership and composition

- `src/main.tsx` composes the React website. Components own browser interaction;
  `src/domain.ts` owns household schemas and pure domain rules.
- `src/server.ts` and `src/mcp-worker.ts` are separate transport/authentication
  composition roots. Share household operations through `recipes.ts`, `groceries.ts`,
  `household.ts`, and matching modules; do not route one Worker through the other's
  entrypoint or duplicate its persistence/validation logic.
- Keep request, storage, vendor, and browser adapters beside their owning boundary.
  Inner operations receive meaningful parsed values. Do not create packages, Layers,
  service wrappers, or dependency bundles for hypothetical reuse.
- Alchemy owns production infrastructure. Native Preview tools own disposable
  Preview lifecycle. `cloudflare.config.ts` shares build configuration, not production
  deployment ownership. Use the tasks in `Taskfile.yml` for repeatable workflows.

## Infrastructure and invocation lifetimes

Local application data stays in local D1/KV; integration tests use disposable
Miniflare resources; Previews use isolated D1/KV and Access resources. Never reuse
production data or credentials to work around a missing local capability. Document
intentional shared account infrastructure and read-only production checks separately.
Provision dependencies before consumers, destroy consumers before dependencies,
preserve environment identity, and make ephemeral resources destroyable. Follow
`AGENTS.md` and the README for authorization and Preview cleanup.

Do not retain request-scoped Cloudflare I/O objects across invocations. Pass current
bindings and execution context at the composition root. Bounded pure caches and
documented isolate-local deduplication are not substitutes for cross-isolate locks.

## Provenance, parsing, and types

Treat types as evidence; never erase evidence and assert it back.

- Decode genuinely unknown HTTP/JSON, SQL rows, native storage, configuration, files,
  and vendor output at their owning boundary with the existing Effect Schema, Zod,
  or deliberate domain parser. SQL generics alone do not validate stored data.
- Parse the expected contract, not merely a generic record shape. For open-ended
  external formats such as JSON-LD, keep structural inspection inside that adapter.
- Preserve known domain/library types through functions. Do not widen them to
  `unknown`, `object`, or `Record<string, unknown>` for implementation convenience.
- Use a typed decoder when the value matches the schema's actual encoded type.
  Revalidate newly patched/computed constraints with the owning schema/refinement;
  do not round-trip established values through JSON just to refine them.
- Reuse owner-provided types and generics; avoid local approximations of available
  platform/library contracts. Instantiate reusable decoders beside their owner when
  reuse is useful; do not add one-use parser wrappers.
- No chained assertions (`as unknown as`, `as any as`), explicit `any`, or non-null
  assertions. Branch on optional values instead. Literal `as const` preserves inference
  and is not a fabricated runtime proof.
- An unavoidable platform/library assertion must be narrow, immediately adjacent to
  runtime evidence, and documented with `SAFETY`, the upstream typing limitation,
  and the smoke/E2E check that verifies the invariant. Never widen a value first.

Hearth uses native optional properties, `undefined`, `null`, and Effect `Option` as
defined by its owning schema/API. Preserve their distinct meanings: omitted ingredient
links request matching, explicit `null` disables it; omitted recipe patch fields stay
unchanged; nullable optimistic-save guards are not interchangeable with omission.
Do not migrate representation or wire contracts merely to match the source project.

## Effect style and failure translation

Import stable Effect modules as named namespaces from `effect`; unstable modules
use their narrow public entrypoint. Use `Effect.gen` or generator-based `Effect.fn`
for dependent workflows, branches, loops, and named intermediate values. Use pipes
for one pure transform and cross-cutting error handling, tracing, timeout, retries,
and provision. Keep business decisions visible in ordinary control flow.

Translate tagged expected errors explicitly with `catchTag`/`catchTags`; preserve
already-correct errors. `mapError` is appropriate when the entire error channel has
one intentional meaning. Do not hide newly introduced error tags in catch-all
translation. If adding a contextual service/Layer, retain its dependency requirements
until the composition root provides them; do not introduce manual dependency bundles.

Read [error design](errors.md) before changing errors, rendered failure messages,
HTTP statuses, retry guidance, or failure telemetry.

## Public contracts and documentation

The existing domain schemas and MCP input/output schemas own their contracts. Update
schemas and consumers together, use truthful examples and authentication metadata,
and verify discovery and actual boundary responses. Do not hand-edit generated
artifacts or invent routes, hostnames, IDs, or request ordering.

Every first-party exported TypeScript/JavaScript declaration, including public class
members, needs directly attached JSDoc stating its sharpest caller-visible constraint,
side effect, or ownership fact. Document an original declaration once; re-exports rely
on it. Avoid comments that merely repeat a name/type. Internal code needs comments
when maintenance depends on an unobvious invariant, tradeoff, lifetime, or safety proof.
Use durable domain vocabulary, not ticket names or migration planning language.
For framework default configuration objects, document the exported composition/config
and public callbacks where they define a runtime contract.

## Validation and scope

Preserve behavior while correcting standards violations: do not change routes,
status codes, null/omission semantics, ordering, authentication, persistence, or UI
interaction as an incidental cleanup. Keep changes in their owner; avoid speculative
abstractions and unrelated refactors.

Hearth uses integration smoke and E2E tests, not unit tests or mocked modules. Check
application-owned transformations, compatibility, persistence, and public failures
through real boundaries rather than restating schema declarations. Run `npx task test`
and relevant browser/Preview smokes; types, lint, formatting, and builds supplement
runtime verification. Inspect rendered states for visual changes. Vendored third-party
code, generated assets, dependency snapshots, and upstream fixtures are not maintained
as Hearth source: preserve their provenance instead of rewriting them to these rules.
