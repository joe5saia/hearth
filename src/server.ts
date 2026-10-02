import { Data, Effect, Schema } from "effect";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { WebsiteEnv } from "../alchemy.run";
import {
  MealSchema,
  RecipeSchema,
  ExtraSchema,
  CheckSchema,
  CollectionSchema,
  GroceryItemSchema,
  ShoppingOrderSchema,
  type Collection,
  validDate,
  type Meal,
  type Extra,
  type Household,
} from "./domain";
import { sampleRecipes, sampleMeals } from "./seed";
import { importRecipe } from "./recipe-import";
import { parseRecipe, recipeStatement, validateRecipe, type RecipeRow } from "./recipes";
import { matchRecipeIngredients, RecipeInputError } from "./recipes";
import { parseGrocery, validateGrocery, validateShoppingOrder, type GroceryRow } from "./groceries";
import {
  matchIngredients,
  matchingFailureReason,
  normalizationModel,
  selectionModel,
} from "./ingredient-matching";

class ApiError extends Data.TaggedError("ApiError")<{ status: number; message: string }> {}

const invalid = (message: string) => new ApiError({ status: 400, message });

const database = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof RecipeInputError
        ? invalid(error.message)
        : new ApiError({ status: 500, message: "We couldn’t save that change. Please try again." }),
  });

const readJson = <S extends Schema.Constraint>(request: Request, schema: S, message: string) =>
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

function mealStatement(db: WebsiteEnv["DB"], meal: Meal) {
  return db
    .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,scale=excluded.scale,note=excluded.note`)
    .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note);
}

function api(request: Request, db: D1Database, ai?: Ai) {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/api/household") {
      const [recipes, meals, extras, checks, collections, groceries, shoppingOrder] = yield* database(
        async () => {
          const results = await db.batch([
            db.prepare("SELECT * FROM recipes ORDER BY title"),
            db.prepare("SELECT * FROM meals ORDER BY date,slot,id"),
            db.prepare("SELECT * FROM extras ORDER BY rowid"),
            db.prepare("SELECT * FROM checks WHERE checked=1"),
            db.prepare("SELECT * FROM collections ORDER BY name"),
            db.prepare("SELECT * FROM groceries ORDER BY name,id"),
            db.prepare("SELECT aisles,items FROM shopping_order WHERE id=1"),
          ]);

          // SAFETY: These fixed SELECTs return the listed row types in this order.
          // One D1 batch keeps recipes and collections in the same transaction snapshot.
          return results as [
            D1Result<RecipeRow>,
            D1Result<Meal>,
            D1Result<Extra>,
            D1Result<typeof CheckSchema.Type>,
            D1Result<Collection>,
            D1Result<GroceryRow>,
            D1Result<{ aisles: string; items: string }>,
          ];
        },
      );

      const parsed = recipes.results.map(parseRecipe);

      return Response.json({
        collections: collections.results,
        recipes: parsed,
        meals: meals.results,
        extras: extras.results,
        checks: checks.results,
        groceries: groceries.results.map(parseGrocery),
        shoppingOrder: shoppingOrder.results[0]
          ? {
              aisles: JSON.parse(shoppingOrder.results[0].aisles),
              items: JSON.parse(shoppingOrder.results[0].items),
            }
          : { aisles: [], items: [] },
      } satisfies Household);
    }

    if (method === "PUT" && path === "/api/groceries") {
      const item = yield* readJson(request, GroceryItemSchema, "Invalid grocery item.");

      if (!validateGrocery(item))
        return yield* invalid("Check the grocery name, package quantity, unit, and URL.");
      yield* database(() =>
        db
          .prepare(`INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,aisle=excluded.aisle,quantity=excluded.quantity,unit=excluded.unit,aliases=excluded.aliases`)
          .bind(
            item.id,
            item.name.trim(),
            item.url,
            item.aisle.trim(),
            item.quantity,
            item.unit,
            JSON.stringify(item.aliases),
          )
          .run(),
      );

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/groceries/")) {
      const id = yield* decodeId(path, "/api/groceries/");

      const result = yield* database(() =>
        db
          .prepare(`DELETE FROM groceries WHERE id=? AND NOT EXISTS
        (SELECT 1 FROM recipes,json_each(recipes.ingredients) AS ingredient WHERE json_extract(ingredient.value,'$.groceryItemId')=?)`)
          .bind(id, id)
          .run(),
      );

      if (!result.meta.changes)
        return yield* new ApiError({
          status: 409,
          message: "This grocery is used by a recipe or no longer exists.",
        });

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/shopping-order") {
      const order = yield* readJson(request, ShoppingOrderSchema, "Invalid shopping order.");

      if (!validateShoppingOrder(order)) return yield* invalid("Shopping order must contain unique strings.");
      yield* database(() =>
        db
          .prepare(
            "INSERT INTO shopping_order(id,aisles,items) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET aisles=excluded.aisles,items=excluded.items",
          )
          .bind(JSON.stringify(order.aisles), JSON.stringify(order.items))
          .run(),
      );

      return Response.json({ ok: true });
    }

    if (method === "POST" && path === "/api/groceries/match") {
      const started = performance.now();
      const runId = crypto.randomUUID();
      const ray = request.headers.get("Cf-Ray");
      console.info(
        JSON.stringify({
          event: "ingredient_matching_started",
          runId,
          cfRay: ray && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
          normalizationModel,
          selectionModel,
        }),
      );

      if (!ai) {
        console.error(
          JSON.stringify({
            event: "ingredient_matching_failed",
            runId,
            stage: "setup",
            reason: "ai_unavailable",
          }),
        );

        return yield* new ApiError({
          status: 503,
          message:
            "AI ingredient matching requires a Cloudflare deployment. Local recipe saves still use exact matching.",
        });
      }

      let stage = "snapshot";

      const report = yield* database(async () => {
        try {
          const snapshot = await db.batch([
            db.prepare("SELECT * FROM recipes"),
            db.prepare("SELECT * FROM groceries ORDER BY name,id"),
            db.prepare("SELECT version FROM grocery_revision WHERE id=1"),
          ]);

          // SAFETY: These fixed SELECTs return recipe rows, grocery rows and the catalog revision in order.
          const [rows, products, revision] = snapshot as [
            D1Result<RecipeRow>,
            D1Result<GroceryRow>,
            D1Result<{ version: number }>,
          ];

          const originals = rows.results.map(parseRecipe);
          stage = "matching";
          const result = await matchIngredients(ai, originals, products.results.map(parseGrocery), db, runId);
          stage = "persistence";

          const changed = result.recipes.flatMap((recipe, index) => {
            const links = recipe.ingredients.filter(
              (ingredient, position) =>
                ingredient.groceryItemId !== originals[index].ingredients[position].groceryItemId,
            ).length;

            const edits = recipe.ingredients.filter(
              (ingredient, position) =>
                JSON.stringify(ingredient) !== JSON.stringify(originals[index].ingredients[position]),
            ).length;

            return edits ? [{ recipe, before: rows.results[index], links, edits }] : [];
          });

          console.info(
            JSON.stringify({
              event: "ingredient_matching_persisting",
              runId,
              changedRecipes: changed.length,
              proposedMatches: result.report.matched,
              elapsedMs: Math.round(performance.now() - started),
            }),
          );

          if (!changed.length) return result.report;

          const writes = await db.batch(
            changed.map(({ recipe, before }) =>
              db
                .prepare(
                  "UPDATE recipes SET ingredients=? WHERE id=? AND ingredients=? AND title=? AND description=? AND category=? AND instructions=? AND (SELECT version FROM grocery_revision WHERE id=1)=?",
                )
                .bind(
                  JSON.stringify(recipe.ingredients),
                  recipe.id,
                  before.ingredients,
                  before.title,
                  before.description,
                  before.category,
                  before.instructions,
                  revision.results[0].version,
                ),
            ),
          );

          for (const [index, saved] of writes.entries()) {
            if (!saved.meta.changes) {
              const { links, edits } = changed[index];
              result.report.matched -= links;
              result.report.conflicts += edits;
            }
          }

          return result.report;
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "ingredient_matching_failed",
              runId,
              stage,
              reason: matchingFailureReason(error),
              elapsedMs: Math.round(performance.now() - started),
            }),
          );
          throw error;
        }
      });

      report.totalMs = performance.now() - started;
      console.info(
        JSON.stringify({
          event: "ingredient_matching_completed",
          runId,
          outcome: report.failed || report.conflicts ? "partial" : "complete",
          ...report,
        }),
      );

      return Response.json({ ok: true, report });
    }

    if (method === "PUT" && path === "/api/collections") {
      const collection = yield* readJson(request, CollectionSchema, "Add a collection name.");

      const name = collection.name.trim();

      if (!collection.id || collection.id.length > 100 || !name || name.length > 100)
        return yield* invalid("Add a collection name of 100 characters or less.");

      const result = yield* database(() =>
        db
          .prepare(`INSERT INTO collections(id,name) SELECT ?,? WHERE NOT EXISTS
          (SELECT 1 FROM collections WHERE name=? AND id<>?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name`)
          .bind(collection.id, name, name, collection.id)
          .run(),
      );

      if (!result.meta.changes)
        return yield* new ApiError({ status: 409, message: "A collection with that name already exists." });

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/collections/")) {
      const id = yield* decodeId(path, "/api/collections/");
      const result = yield* database(() => db.prepare("DELETE FROM collections WHERE id=?").bind(id).run());

      if (!result.meta.changes)
        return yield* new ApiError({ status: 404, message: "That collection no longer exists." });

      return Response.json({ ok: true });
    }

    if (method === "POST" && path === "/api/recipes/import") {
      const input = yield* readJson(
        request,
        Schema.Struct({ url: Schema.String }),
        "Paste a NYT Cooking recipe URL.",
      );

      if (input.url.length > 4000) return yield* invalid("That URL is too long.");

      const result = yield* Effect.tryPromise({
        try: () => importRecipe(input.url.trim()),
        catch: (error) =>
          invalid(
            error instanceof Error ? error.message : "The recipe couldn’t be imported. Please try again.",
          ),
      });

      if (!validateRecipe(result.recipe))
        return yield* invalid("This recipe contains missing or unsupported fields. Please add it manually.");

      return Response.json(result);
    }

    if (method === "PUT" && path === "/api/recipes") {
      const recipe = yield* readJson(request, RecipeSchema, "The recipe is missing required fields.");

      if (!validateRecipe(recipe))
        return yield* invalid(
          "Check your recipe: add a title, positive quantities, ingredients, instructions, and valid URLs.",
        );

      if (recipe.category) {
        const collection = yield* database(() =>
          db.prepare("SELECT id FROM collections WHERE name=? COLLATE BINARY").bind(recipe.category).first(),
        );

        if (!collection)
          return yield* invalid("That collection no longer exists. Choose another collection.");
      }

      const [linked] = yield* database(() => matchRecipeIngredients(db, [recipe]));
      yield* database(() => recipeStatement(db, linked).run());

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path.startsWith("/api/recipes/rating/")) {
      const id = yield* decodeId(path, "/api/recipes/rating/");

      const { rating } = yield* readJson(
        request,
        Schema.Struct({ rating: RecipeSchema.fields.rating }),
        "Choose a valid recipe rating.",
      );

      const result = yield* database(() =>
        db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(rating, id).run(),
      );

      if (!result.meta.changes)
        return yield* new ApiError({ status: 404, message: "That recipe no longer exists." });

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
        return yield* new ApiError({
          status: 409,
          message: "Remove this recipe from your meal plan before deleting it.",
        });

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/meals") {
      const meal = yield* readJson(request, MealSchema, "The meal is missing required fields.");

      if (
        !meal.id ||
        meal.id.length > 100 ||
        !validDate(meal.date) ||
        meal.scale <= 0 ||
        meal.scale > 100 ||
        meal.note.length > 2000
      )
        return yield* invalid("Choose a valid date and a recipe scale between 0 and 100.");

      if (meal.recipeId === null) {
        if (!meal.note.trim()) return yield* invalid("Write a note for this meal.");
      } else {
        const recipe = yield* database(() =>
          db.prepare("SELECT id FROM recipes WHERE id=?").bind(meal.recipeId).first(),
        );

        if (!recipe) return yield* invalid("That recipe no longer exists. Choose another recipe.");
      }

      yield* database(() => mealStatement(db, meal).run());

      return Response.json({ ok: true });
    }

    if (method === "DELETE" && path.startsWith("/api/meals/")) {
      const id = yield* decodeId(path, "/api/meals/");
      yield* database(() => db.prepare("DELETE FROM meals WHERE id=?").bind(id).run());

      return Response.json({ ok: true });
    }

    if (method === "PUT" && path === "/api/extras") {
      const extra = yield* readJson(request, ExtraSchema, "The item is missing required fields.");

      if (
        !extra.id ||
        extra.id.length > 100 ||
        !extra.name.trim() ||
        extra.name.length > 200 ||
        ![0, 1].includes(extra.checked)
      )
        return yield* invalid("Add an item name of 200 characters or less.");
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
      const check = yield* readJson(request, CheckSchema, "Invalid shopping item.");

      if (check.key.length > 1000 || ![0, 1].includes(check.checked))
        return yield* invalid("Invalid shopping item.");
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

      if (!validDate(today)) return yield* invalid("Choose a valid sample week.");
      const existing = yield* database(() => db.prepare("SELECT id FROM recipes LIMIT 1").first());

      if (existing)
        return yield* new ApiError({
          status: 409,
          message: "Sample recipes are only added to an empty household.",
        });

      const collections = yield* database(() =>
        db.prepare("SELECT name FROM collections").all<{ name: string }>(),
      );

      const linkedSamples = yield* database(() => matchRecipeIngredients(db, sampleRecipes));
      yield* database(() =>
        db.batch([
          ...linkedSamples.map((recipe) =>
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

    return yield* new ApiError({ status: 404, message: "That page couldn’t be found." });
  });
}

// Internal transport shared by the authenticated website and MCP entrypoints.
// Authentication stays at each entrypoint; this function is never a public route.
export function householdApi(request: Request, db: D1Database, ai?: Ai): Promise<Response> {
  return Effect.runPromise(
    api(request, db, ai).pipe(
      Effect.catchTag("ApiError", (error) =>
        Effect.succeed(Response.json({ error: error.message }, { status: error.status })),
      ),
      Effect.catchCause(() =>
        Effect.succeed(Response.json({ error: "Something went wrong. Please try again." }, { status: 500 })),
      ),
      Effect.tap((response) => Effect.sync(() => response.headers.set("Cache-Control", "no-store"))),
    ),
  );
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

    return householdApi(request, env.DB, env.AI);
  },
};
