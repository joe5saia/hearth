import { Data, Effect, Schema } from "effect";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { WebsiteEnv } from "../alchemy.run";
import {
  MealSchema,
  RecipeSchema,
  ExtraSchema,
  CheckSchema,
  CollectionSchema,
  type Collection,
  validDate,
  type Meal,
  type Extra,
  type Household,
} from "./domain";
import { sampleRecipes, sampleMeals } from "./seed";
import { importRecipe } from "./recipe-import";
import { parseRecipe, recipeStatement, validateRecipe, type RecipeRow } from "./recipes";

class ApiError extends Data.TaggedError("ApiError")<{ status: number; message: string }> {}

const invalid = (message: string) => new ApiError({ status: 400, message });

const database = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new ApiError({ status: 500, message: "We couldn’t save that change. Please try again." }),
  });

const readJson = (request: Request) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => invalid("Please send valid JSON.") });

const decodeId = (path: string, prefix: string) =>
  Effect.try({
    try: () => decodeURIComponent(path.slice(prefix.length)),
    catch: () => invalid("Invalid item ID."),
  });

function mealStatement(db: WebsiteEnv["DB"], meal: Meal) {
  return db
    .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,scale=excluded.scale,note=excluded.note`)
    .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note);
}

function api(request: Request, env: WebsiteEnv) {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    if (method === "GET" && path === "/api/household") {
      const [recipes, meals, extras, checks, collections] = yield* database(async () => {
        const results = await db.batch([
          db.prepare("SELECT * FROM recipes ORDER BY title"),
          db.prepare("SELECT * FROM meals ORDER BY date,slot,id"),
          db.prepare("SELECT * FROM extras ORDER BY rowid"),
          db.prepare("SELECT * FROM checks WHERE checked=1"),
          db.prepare("SELECT * FROM collections ORDER BY name"),
        ]);

        // SAFETY: These fixed SELECTs return the listed row types in this order.
        // One D1 batch keeps recipes and collections in the same transaction snapshot.
        return results as [
          D1Result<RecipeRow>,
          D1Result<Meal>,
          D1Result<Extra>,
          D1Result<{ key: string; checked: number }>,
          D1Result<Collection>,
        ];
      });

      const parsed = recipes.results.map(parseRecipe);

      return Response.json({
        collections: collections.results,
        recipes: parsed,
        meals: meals.results,
        extras: extras.results,
        checks: checks.results,
      } satisfies Household);
    }

    if (method === "PUT" && path === "/api/collections") {
      const body = yield* readJson(request);

      const collection = yield* Schema.decodeUnknownEffect(CollectionSchema)(body).pipe(
        Effect.mapError(() => invalid("Add a collection name.")),
      );

      const name = collection.name.trim();

      if (!collection.id || collection.id.length > 100 || !name || name.length > 100)
        return yield* Effect.fail(invalid("Add a collection name of 100 characters or less."));

      const result = yield* database(() =>
        db
          .prepare(`INSERT INTO collections(id,name) SELECT ?,? WHERE NOT EXISTS
          (SELECT 1 FROM collections WHERE name=? AND id<>?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name`)
          .bind(collection.id, name, name, collection.id)
          .run(),
      );

      if (!result.meta.changes)
        return yield* Effect.fail(
          new ApiError({ status: 409, message: "A collection with that name already exists." }),
        );

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/collections/")) {
      const id = yield* decodeId(path, "/api/collections/");
      const result = yield* database(() => db.prepare("DELETE FROM collections WHERE id=?").bind(id).run());

      if (!result.meta.changes)
        return yield* Effect.fail(
          new ApiError({ status: 404, message: "That collection no longer exists." }),
        );

      return Response.json({ ok: true });
    }

    if (method === "POST" && path === "/api/recipes/import") {
      const body = yield* readJson(request);

      const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))(body).pipe(
        Effect.mapError(() => invalid("Paste a NYT Cooking recipe URL.")),
      );

      if (input.url.length > 4000) return yield* Effect.fail(invalid("That URL is too long."));

      const result = yield* Effect.tryPromise({
        try: () => importRecipe(input.url.trim()),
        catch: (error) =>
          invalid(
            error instanceof Error ? error.message : "The recipe couldn’t be imported. Please try again.",
          ),
      });

      if (!validateRecipe(result.recipe))
        return yield* Effect.fail(
          invalid("This recipe contains missing or unsupported fields. Please add it manually."),
        );

      return Response.json(result);
    }

    if (method === "PUT" && path === "/api/recipes") {
      const body = yield* readJson(request);

      const recipe = yield* Schema.decodeUnknownEffect(RecipeSchema)(body).pipe(
        Effect.mapError(() => invalid("The recipe is missing required fields.")),
      );

      if (!validateRecipe(recipe))
        return yield* Effect.fail(
          invalid(
            "Check your recipe: add a title, positive quantities, ingredients, instructions, and valid URLs.",
          ),
        );

      if (recipe.category) {
        const collection = yield* database(() =>
          db.prepare("SELECT id FROM collections WHERE name=? COLLATE BINARY").bind(recipe.category).first(),
        );

        if (!collection)
          return yield* Effect.fail(invalid("That collection no longer exists. Choose another collection."));
      }

      yield* database(() => recipeStatement(db, recipe).run());

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path.startsWith("/api/recipes/rating/")) {
      const id = yield* decodeId(path, "/api/recipes/rating/");
      const body = yield* readJson(request);

      const { rating } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ rating: RecipeSchema.fields.rating }),
      )(body).pipe(Effect.mapError(() => invalid("Choose a valid recipe rating.")));

      const result = yield* database(() =>
        db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(rating, id).run(),
      );

      if (!result.meta.changes)
        return yield* Effect.fail(new ApiError({ status: 404, message: "That recipe no longer exists." }));

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/recipes/")) {
      const id = yield* decodeId(path, "/api/recipes/");

      // The conditional delete and FK restriction both protect planned recipes.
      const result = yield* database(() =>
        db
          .prepare("DELETE FROM recipes WHERE id=? AND NOT EXISTS (SELECT 1 FROM meals WHERE recipeId=?)")
          .bind(id, id)
          .run(),
      );

      if (!result.meta.changes)
        return yield* Effect.fail(
          new ApiError({
            status: 409,
            message: "Remove this recipe from your meal plan before deleting it.",
          }),
        );

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/meals") {
      const body = yield* readJson(request);

      const meal = yield* Schema.decodeUnknownEffect(MealSchema)(body).pipe(
        Effect.mapError(() => invalid("The meal is missing required fields.")),
      );

      if (
        !meal.id ||
        meal.id.length > 100 ||
        !validDate(meal.date) ||
        meal.scale <= 0 ||
        meal.scale > 100 ||
        meal.note.length > 2000
      )
        return yield* Effect.fail(invalid("Choose a valid date and a recipe scale between 0 and 100."));

      const recipe = yield* database(() =>
        db.prepare("SELECT id FROM recipes WHERE id=?").bind(meal.recipeId).first(),
      );

      if (!recipe) return yield* Effect.fail(invalid("That recipe no longer exists. Choose another recipe."));
      yield* database(() => mealStatement(db, meal).run());

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/meals/")) {
      const id = yield* decodeId(path, "/api/meals/");
      yield* database(() => db.prepare("DELETE FROM meals WHERE id=?").bind(id).run());

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/extras") {
      const body = yield* readJson(request);

      const extra = yield* Schema.decodeUnknownEffect(ExtraSchema)(body).pipe(
        Effect.mapError(() => invalid("The item is missing required fields.")),
      );

      if (
        !extra.id ||
        extra.id.length > 100 ||
        !extra.name.trim() ||
        extra.name.length > 200 ||
        ![0, 1].includes(extra.checked)
      )
        return yield* Effect.fail(invalid("Add an item name of 200 characters or less."));
      yield* database(() =>
        db
          .prepare(
            "INSERT INTO extras(id,name,checked) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,checked=excluded.checked",
          )
          .bind(extra.id, extra.name.trim(), extra.checked)
          .run(),
      );

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/extras/")) {
      const id = yield* decodeId(path, "/api/extras/");
      yield* database(() => db.prepare("DELETE FROM extras WHERE id=?").bind(id).run());

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/checks") {
      const body = yield* readJson(request);

      const check = yield* Schema.decodeUnknownEffect(CheckSchema)(body).pipe(
        Effect.mapError(() => invalid("Invalid shopping item.")),
      );

      if (check.key.length > 1000 || ![0, 1].includes(check.checked))
        return yield* Effect.fail(invalid("Invalid shopping item."));
      yield* database(() =>
        check.checked
          ? db
              .prepare("INSERT INTO checks(key,checked) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET checked=1")
              .bind(check.key)
              .run()
          : db.prepare("DELETE FROM checks WHERE key=?").bind(check.key).run(),
      );

      return Response.json({ ok: true });
    }

    if (method === "POST" && path === "/api/demo") {
      const today = url.searchParams.get("today") ?? "";

      if (!validDate(today)) return yield* Effect.fail(invalid("Choose a valid sample week."));
      const existing = yield* database(() => db.prepare("SELECT id FROM recipes LIMIT 1").first());

      if (existing)
        return yield* Effect.fail(
          new ApiError({ status: 409, message: "Sample recipes are only added to an empty household." }),
        );

      const collections = yield* database(() =>
        db.prepare("SELECT name FROM collections").all<{ name: string }>(),
      );

      yield* database(() =>
        db.batch([
          ...sampleRecipes.map((recipe) =>
            recipeStatement(db, {
              ...recipe,
              category: collections.results.some((collection) => collection.name === recipe.category)
                ? recipe.category
                : "",
            }),
          ),
          ...sampleMeals(today).map((meal) => mealStatement(db, meal)),
          db.prepare("INSERT INTO extras(id,name,checked) VALUES('sample-extra','Greek yogurt',0)"),
        ]),
      );

      return Response.json({ ok: true });
    }

    return yield* Effect.fail(new ApiError({ status: 404, message: "That page couldn’t be found." }));
  });
}

const accessIssuer = "https://saiaai.cloudflareaccess.com";

const accessKeys = createRemoteJWKSet(new URL(`${accessIssuer}/cdn-cgi/access/certs`));

export default {
  async fetch(request: Request, env: WebsiteEnv & { PREVIEW_CLIENT_ID?: string }): Promise<Response> {
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

        const { payload } = await jwtVerify(token, accessKeys, {
          issuer: accessIssuer,
          audience: env.ACCESS_AUD,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "sub"],
        });

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
        }
      } catch (error) {
        // Never log assertions, claims, cookies, credentials, or raw exceptions.
        // Keep dependency failures distinguishable from missing/invalid identity.
        const ray = request.headers.get("Cf-Ray");
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

    if (request.headers.get("Sec-Fetch-Site") === "cross-site" && !["GET", "HEAD"].includes(request.method)) {
      return Response.json({ error: "Cross-site changes are not allowed." }, { status: 403 });
    }

    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (
      !["GET", "HEAD"].includes(request.method) &&
      !request.headers.get("content-type")?.startsWith("application/json")
    ) {
      return Response.json({ error: "Use application/json." }, { status: 415 });
    }

    return Effect.runPromise(
      api(request, env).pipe(
        Effect.catchTag("ApiError", (error) =>
          Effect.succeed(Response.json({ error: error.message }, { status: error.status })),
        ),
        Effect.catchCause(() =>
          Effect.succeed(
            Response.json({ error: "Something went wrong. Please try again." }, { status: 500 }),
          ),
        ),
        Effect.map((response) => {
          response.headers.set("Cache-Control", "no-store");

          return response;
        }),
      ),
    );
  },
};
