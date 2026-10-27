import { Effect, Option, Schema, Tracer } from "effect";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { WebsiteEnv } from "../alchemy.run";
import { publicInstallPaths } from "./install-assets";
import { observedFetch, record, type Observation, type TelemetryEnv } from "./observability";
import { apiOperation, BrowserBatchSchema } from "./telemetry-contract";
import {
  MealSchema,
  RecipeSchema,
  ExtraSchema,
  CheckWriteSchema,
  CollectionSchema,
  GroceryItemSchema,
  RenameAisleSchema,
  ShoppingOrderSchema,
  DateSchema,
  RecipeId,
  GroceryId,
} from "./domain";
import { ValidationError, NotFound, ExpectedRevisionSchema, requireRevision } from "./storage";
import { saveRecipe, deleteRecipe, rateRecipe, importRecipeDraft } from "./recipes";
import { saveGrocery, saveGroceryToList, deleteGrocery, renameAisle } from "./groceries";
import {
  getHousehold,
  saveCollection,
  deleteCollection,
  saveMeal,
  deleteMeal,
  patchMealNote,
  saveExtra,
  deleteExtra,
  patchExtraChecked,
  setShoppingChecked,
  setShoppingOrder,
  addDemoData,
} from "./household";
import { matchGroceries, matchNewRecipes } from "./matching-run";
import { submitFeedback, type FeedbackEnv } from "./feedback";
import { FeedbackIdentitySchema, type Feedback } from "./feedback-contract";
import { photoResponse } from "./photos";

const invalid = (message: string) => new ValidationError({ message });

const readJson = <S extends Schema.Constraint>(request: Pick<Request, "json">, schema: S, message: string) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => invalid("Please send valid JSON."),
    });

    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(() => invalid(message)));
  });

const decodeId = (path: string, prefix: string) =>
  Effect.try({
    try: () => decodeURIComponent(path.slice(prefix.length)),
    catch: () => invalid("Invalid item ID."),
  });

const brandedId = <S extends Schema.Constraint>(path: string, prefix: string, schema: S) =>
  Effect.gen(function* () {
    const id = yield* decodeId(path, prefix);

    return yield* Schema.decodeUnknownEffect(schema)(id).pipe(
      Effect.mapError(() => invalid("Invalid item ID.")),
    );
  });

function api(request: Request, db: D1Database, ai?: Ai, ctx?: ExecutionContext) {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path.startsWith("/photos/upload-")) return yield* photoResponse(db, request);

    const guarded =
      (method === "PUT" &&
        [
          "/api/recipes",
          "/api/meals",
          "/api/groceries",
          "/api/shopping-items",
          "/api/collections",
          "/api/extras",
          "/api/shopping-order",
        ].includes(path)) ||
      (method === "DELETE" && /^\/api\/(recipes|meals|groceries|collections|extras)\//.test(path));

    let expectedRevision: string | null | undefined;

    if (guarded) {
      const guard =
        request.body === null
          ? { expectedRevision: undefined }
          : yield* readJson(
              request.clone(),
              Schema.Struct({ expectedRevision: Schema.optional(ExpectedRevisionSchema) }),
              "Reload before saving.",
            );

      expectedRevision = yield* requireRevision(guard.expectedRevision);
    }

    if (method === "GET" && path === "/api/household") {
      const household = yield* getHousehold(db);
      const started = performance.now();
      const body = JSON.stringify(household);
      yield* record("household_response", {
        bytes: new TextEncoder().encode(body).byteLength,
        durationMs: performance.now() - started,
      });

      return new Response(body, { headers: { "Content-Type": "application/json" } });
    }

    if (method === "PUT" && path === "/api/groceries") {
      yield* saveGrocery(
        db,
        yield* readJson(request, GroceryItemSchema, "Invalid grocery item."),
        expectedRevision,
      );
    } else if (method === "DELETE" && path.startsWith("/api/groceries/")) {
      yield* deleteGrocery(db, yield* brandedId(path, "/api/groceries/", GroceryId), expectedRevision);
    } else if (method === "PUT" && path === "/api/shopping-items") {
      yield* saveGroceryToList(
        db,
        yield* readJson(request, GroceryItemSchema, "Invalid grocery item."),
        expectedRevision,
      );
    } else if (method === "PUT" && path === "/api/shopping-aisles") {
      yield* renameAisle(db, yield* readJson(request, RenameAisleSchema, "Enter a valid aisle name."));
    } else if (method === "PUT" && path === "/api/shopping-order") {
      yield* setShoppingOrder(
        db,
        yield* readJson(request, ShoppingOrderSchema, "Invalid shopping order."),
        expectedRevision,
      );
    } else if (method === "POST" && path === "/api/groceries/match") {
      return Response.json(yield* matchGroceries(db, ai, request.headers.get("Cf-Ray")));
    } else if (method === "PUT" && path === "/api/collections") {
      yield* saveCollection(
        db,
        yield* readJson(request, CollectionSchema, "Add a collection name."),
        expectedRevision,
      );
    } else if (method === "DELETE" && path.startsWith("/api/collections/")) {
      yield* deleteCollection(db, yield* decodeId(path, "/api/collections/"), expectedRevision);
    } else if (method === "POST" && path === "/api/recipes/import") {
      const input = yield* readJson(
        request,
        Schema.Struct({ url: Schema.String }),
        "Paste a NYT Cooking recipe URL.",
      );

      return Response.json(yield* importRecipeDraft(input.url));
    } else if (method === "POST" && path === "/api/recipes/match") {
      const draft = yield* readJson(request, RecipeSchema, "The recipe is missing required fields.");

      return Response.json(yield* matchGroceries(db, ai, request.headers.get("Cf-Ray"), undefined, draft));
    } else if (method === "PUT" && path === "/api/recipes") {
      const recipe = yield* readJson(request, RecipeSchema, "The recipe is missing required fields.");

      const saved = yield* saveRecipe(db, recipe, expectedRevision);

      if (saved.created) matchNewRecipes(db, ai, ctx, [recipe.id]);
    } else if (method === "PUT" && path.startsWith("/api/recipes/rating/")) {
      const id = yield* brandedId(path, "/api/recipes/rating/", RecipeId);

      const { rating } = yield* readJson(
        request,
        Schema.Struct({ rating: RecipeSchema.fields.rating }),
        "Choose a valid recipe rating.",
      );

      yield* rateRecipe(db, id, rating);
    } else if (method === "DELETE" && path.startsWith("/api/recipes/")) {
      yield* deleteRecipe(db, yield* brandedId(path, "/api/recipes/", RecipeId), expectedRevision);
    } else if (method === "PUT" && path === "/api/meals") {
      yield* saveMeal(
        db,
        yield* readJson(request, MealSchema, "The meal is missing required fields."),
        expectedRevision,
      );
    } else if (method === "PATCH" && path.startsWith("/api/meals/")) {
      yield* patchMealNote(
        db,
        yield* decodeId(path, "/api/meals/"),
        yield* readJson(
          request,
          Schema.Struct({ note: MealSchema.fields.note, expectedNote: MealSchema.fields.note }),
          "Send the note and the previously read note.",
        ),
      );
    } else if (method === "DELETE" && path.startsWith("/api/meals/")) {
      yield* deleteMeal(db, yield* decodeId(path, "/api/meals/"), expectedRevision);
    } else if (method === "PUT" && path === "/api/extras") {
      yield* saveExtra(
        db,
        yield* readJson(request, ExtraSchema, "The item is missing required fields."),
        expectedRevision,
      );
    } else if (method === "PATCH" && path.startsWith("/api/extras/")) {
      const input = yield* readJson(
        request,
        Schema.Struct({ checked: ExtraSchema.fields.checked }),
        "Choose checked or unchecked.",
      );

      yield* patchExtraChecked(db, yield* decodeId(path, "/api/extras/"), input.checked);
    } else if (method === "DELETE" && path.startsWith("/api/extras/")) {
      yield* deleteExtra(db, yield* decodeId(path, "/api/extras/"), expectedRevision);
    } else if (method === "PUT" && path === "/api/checks") {
      yield* setShoppingChecked(db, yield* readJson(request, CheckWriteSchema, "Invalid shopping item."));
    } else if (method === "POST" && path === "/api/demo") {
      const today = yield* Schema.decodeUnknownEffect(DateSchema)(url.searchParams.get("today") ?? "").pipe(
        Effect.mapError(() => invalid("Choose a valid sample week.")),
      );

      yield* addDemoData(db, today);
    } else return yield* new NotFound({ message: "That page couldn’t be found." });

    return Response.json({ ok: true });
  });
}

/** Serve household JSON with no-store responses; callers must authenticate before dispatch. */
export function householdApi(
  request: Request,
  db: D1Database,
  ai?: Ai,
  observation?: Observation,
  tracer = Tracer.nativeTracer,
  ctx?: ExecutionContext,
): Promise<Response> {
  const failure = (message: string, status: number) =>
    Effect.succeed(Response.json({ error: message }, { status }));

  const program = api(request, db, ai, ctx).pipe(
    Effect.tapError((error) => record("api_failure", { reason: error._tag, outcome: "error" })),
    Effect.withSpan("api.operation", {}, { captureStackTrace: false }),
    Effect.catchTags({
      ValidationError: (error) => failure(error.message, 400),
      MissingReference: (error) => failure(error.message, 400),
      NotFound: (error) => failure(error.message, 404),
      Conflict: (error) => failure(error.message, 409),
      AiUnavailable: (error) => failure(error.message, 503),
      StorageError: () =>
        failure(
          "Household data is unavailable. Refresh to check the current state before retrying any changes.",
          500,
        ),
      StoredDataError: () =>
        failure(
          "Some saved household data couldn’t be read. Refresh to check the current state before retrying any changes. If this continues, report it with the request ID.",
          500,
        ),
    }),
    Effect.satisfiesErrorType<never>(),
    Effect.catchCause(() =>
      record("api_failure", {
        reason: request.signal.aborted ? "aborted" : "internal_error",
        outcome: "error",
      }).pipe(
        Effect.andThen(
          failure(
            "We couldn’t complete this household request. Refresh to check the current state before retrying any changes. If this continues, report it with the request ID.",
            500,
          ),
        ),
      ),
    ),
    Effect.tap((response) =>
      Effect.sync(() => {
        if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
      }),
    ),
  );

  return observation
    ? observation.run(program, tracer, request.signal)
    : Effect.runPromise(program, { signal: request.signal });
}

const accessIssuer = "https://saiaai.cloudflareaccess.com";

const accessKeys = createRemoteJWKSet(new URL(`${accessIssuer}/cdn-cgi/access/certs`));

// A resource bound, not a global/user quota: every isolate has its own window.
let telemetryWindow = 0;

let telemetryBatches = 0;

async function browserTelemetry(request: Request, observation: Observation, local: boolean) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const origin = request.headers.get("Origin");
  const sameOrigin = origin === new URL(request.url).origin;
  const localOrigin = local && (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173");

  if (!sameOrigin && !localOrigin) return new Response(null, { status: 403 });

  if (!observation.env.AXIOM_TOKEN || !observation.env.AXIOM_EVENTS_DATASET)
    return new Response(null, { status: 204 });
  const window = Math.floor(Date.now() / 60000);

  if (window !== telemetryWindow) {
    telemetryWindow = window;
    telemetryBatches = 0;
  }

  if (++telemetryBatches > 120) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  const reader = request.body?.getReader();

  if (!reader) return new Response(null, { status: 400 });
  let bytes = 0;
  const decoder = new TextDecoder();
  let body = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      bytes += chunk.value.byteLength;

      if (bytes > 16384) {
        await reader.cancel();

        return new Response(null, { status: 413 });
      }

      body += decoder.decode(chunk.value, { stream: true });
    }

    body += decoder.decode();

    const events = Schema.decodeUnknownSync(BrowserBatchSchema, { onExcessProperty: "error" })(
      JSON.parse(body),
    );

    for (const { event, ...fields } of events) observation.event(event, fields);

    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
}

/** Website composition root: Access authentication precedes household and asset dispatch. */
export default {
  /** Allow only exact public install reads without Access; protect API writes against cross-site requests. */
  async fetch(
    request: Request,
    env: WebsiteEnv & TelemetryEnv & FeedbackEnv & { PREVIEW_CLIENT_ID?: string },
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const receivedAt = new Date().toISOString();

    return observedFetch(
      request,
      env,
      ctx,
      "hearth-web",
      apiOperation(new URL(request.url).pathname),
      /** Dispatch within the current request's observation and binding lifetime. */
      async (observation, tracer) => {
        let identity: Feedback["delivery"]["identity"] = null;

        // Home-screen installers may fetch these without the browser's Access session.
        // Access path rules also match descendants; only exact read-only files bypass JWT verification here.
        if (
          ["GET", "HEAD"].includes(request.method) &&
          publicInstallPaths.includes(new URL(request.url).pathname)
        ) {
          return env.ASSETS.fetch(request);
        }

        // Static Assets' internal router does not forward ctx.access. Verify the
        // signed assertion instead, including this application's audience tag.
        if (env.LOCAL_DEV !== "true") {
          const token = request.headers.get("Cf-Access-Jwt-Assertion");
          let reason = "missing_assertion";

          try {
            if (!token) throw new Error("Missing Access assertion.");
            reason = "missing_audience";

            if (!env.ACCESS_AUD) throw new Error("Missing Access audience.");
            reason = "verification_failed";

            const { payload } = await observation.step(
              "auth.access",
              () =>
                jwtVerify(token, accessKeys, {
                  issuer: accessIssuer,
                  audience: env.ACCESS_AUD,
                  algorithms: ["RS256"],
                  requiredClaims: ["exp", "sub"],
                }),
              tracer,
            );

            // The production smoke identity stays read-only. Only native Previews
            // bind a separate service identity allowed to mutate their isolated D1.
            if (payload.common_name !== undefined || payload.sub === "") {
              if (env.SMOKE_CLIENT_ID && payload.common_name === env.SMOKE_CLIENT_ID) {
                if (!["GET", "HEAD"].includes(request.method)) {
                  return Response.json({ error: "Smoke-test access is read-only." }, { status: 403 });
                }
              } else if (!env.PREVIEW_CLIENT_ID || payload.common_name !== env.PREVIEW_CLIENT_ID) {
                reason = "unrecognized_service_identity";
                throw new Error("Unrecognized service identity.");
              }
            } else {
              // Only signed household claims; never browser identity headers or service identities.
              const subject = Option.getOrUndefined(
                Schema.decodeUnknownOption(FeedbackIdentitySchema.fields.subject)(payload.sub),
              );

              if (subject !== undefined) {
                identity = {
                  source: "cloudflare-access",
                  subject,
                  email: Option.getOrUndefined(
                    Schema.decodeUnknownOption(FeedbackIdentitySchema.fields.email)(payload.email),
                  ),
                  name: Option.getOrUndefined(
                    Schema.decodeUnknownOption(FeedbackIdentitySchema.fields.name)(payload.name),
                  ),
                };
              }
            }
          } catch (error) {
            // Never log assertions, claims, cookies, credentials, or raw exceptions.
            // Keep dependency failures distinguishable from missing/invalid identity.
            const ray = request.headers.get("Cf-Ray");
            observation.event("auth_failure", { reason, outcome: "rejected" });
            console.warn(
              JSON.stringify({
                event: "access_verification_failed",
                reason,
                code:
                  error instanceof errors.JOSEError
                    ? error.code
                    : error instanceof TypeError
                      ? "TypeError"
                      : null,
                assertionPresent: !!token,
                audienceConfigured: !!env.ACCESS_AUD,
                jwksFresh: accessKeys.fresh,
                cfRay: ray && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
              }),
            );

            return new Response("Cloudflare Access sign-in is required.", {
              status: 403,
              headers: { "Cache-Control": "no-store" },
            });
          }
        }

        if (
          request.headers.get("Sec-Fetch-Site") === "cross-site" &&
          !["GET", "HEAD"].includes(request.method)
        ) {
          return Response.json({ error: "Cross-site changes are not allowed." }, { status: 403 });
        }

        if (new URL(request.url).pathname.startsWith("/photos/upload-"))
          return householdApi(request, env.DB, env.AI, observation, tracer, ctx);

        if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

        if (
          !["GET", "HEAD"].includes(request.method) &&
          !request.headers.get("content-type")?.startsWith("application/json")
        ) {
          return Response.json({ error: "Use application/json." }, { status: 415 });
        }

        if (new URL(request.url).pathname === "/api/telemetry")
          return browserTelemetry(request, observation, env.LOCAL_DEV === "true");

        if (new URL(request.url).pathname === "/api/feedback")
          return submitFeedback(request, env, {
            receivedAt,
            identity,
            environment: env.TELEMETRY_ENVIRONMENT ?? (env.LOCAL_DEV === "true" ? "local" : "production"),
            build: env.TELEMETRY_VERSION ?? "unversioned",
            correlation: {
              operationId: observation.operationId,
              requestId: observation.requestId,
              traceId: observation.traceId,
            },
          });

        return householdApi(request, env.DB, env.AI, observation, tracer, ctx);
      },
    );
  },
};
