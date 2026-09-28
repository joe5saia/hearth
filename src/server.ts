import { Data, Effect, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { WebsiteEnv } from "../alchemy.run";
import {
  IngredientSchema,
  MealSchema,
  RecipeSchema,
  ExtraSchema,
  CheckSchema,
  categories,
  units,
  validDate,
  type Recipe,
  type Meal,
  type Extra,
  type Household,
} from "./domain";
import { sampleRecipes, sampleMeals } from "./seed";
import { importRecipe } from "./recipe-import";

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

const decodeIngredients = Schema.decodeUnknownSync(Schema.Array(IngredientSchema));

const decodeInstructions = Schema.decodeUnknownSync(Schema.Array(Schema.String));

type RecipeRow = Omit<Recipe, "ingredients" | "instructions"> & { ingredients: string; instructions: string };

function recipeStatement(db: WebsiteEnv["DB"], recipe: Recipe) {
  return db
    .prepare(`INSERT INTO recipes (id,title,description,servings,minutes,category,photo,source,ingredients,instructions)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
    servings=excluded.servings,minutes=excluded.minutes,category=excluded.category,photo=excluded.photo,
    source=excluded.source,ingredients=excluded.ingredients,instructions=excluded.instructions`)
    .bind(
      recipe.id,
      recipe.title.trim(),
      recipe.description,
      recipe.servings,
      recipe.minutes,
      recipe.category,
      recipe.photo,
      recipe.source,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.instructions),
    );
}

function mealStatement(db: WebsiteEnv["DB"], meal: Meal) {
  return db
    .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,scale=excluded.scale,note=excluded.note`)
    .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note);
}

function safeUrl(value: string): boolean {
  if (!value) return true;

  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateRecipe(recipe: Recipe): boolean {
  return (
    !!recipe.id &&
    recipe.id.length <= 100 &&
    !!recipe.title.trim() &&
    recipe.title.length <= 150 &&
    recipe.description.length <= 2000 &&
    recipe.servings > 0 &&
    recipe.servings <= 100 &&
    Number.isInteger(recipe.minutes) &&
    recipe.minutes > 0 &&
    recipe.minutes <= 10000 &&
    categories.includes(recipe.category) &&
    safeUrl(recipe.source) &&
    (safeUrl(recipe.photo) ||
      /^\/photos\/[a-z-]+\.jpg$/.test(recipe.photo) ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(recipe.photo)) &&
    new TextEncoder().encode(JSON.stringify(recipe)).length < 1_900_000 &&
    recipe.ingredients.length > 0 &&
    recipe.ingredients.length <= 100 &&
    recipe.ingredients.every(
      (i) =>
        !!i.name.trim() &&
        i.name.length <= 150 &&
        i.quantity > 0 &&
        i.quantity <= 1_000_000 &&
        units.includes(i.unit),
    ) &&
    recipe.instructions.length > 0 &&
    recipe.instructions.length <= 100 &&
    recipe.instructions.every((i) => !!i.trim() && i.length <= 10000)
  );
}

function api(request: Request, env: WebsiteEnv) {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    if (method === "GET" && path === "/api/household") {
      const [recipes, meals, extras, checks] = yield* database(() =>
        Promise.all([
          db.prepare("SELECT * FROM recipes ORDER BY title").all<RecipeRow>(),
          db.prepare("SELECT * FROM meals ORDER BY date,slot,id").all<Meal>(),
          db.prepare("SELECT * FROM extras ORDER BY rowid").all<Extra>(),
          db.prepare("SELECT * FROM checks WHERE checked=1").all<{ key: string; checked: number }>(),
        ]),
      );

      const parsed = recipes.results.map((row) => ({
        ...row,
        ingredients: decodeIngredients(JSON.parse(row.ingredients)),
        instructions: decodeInstructions(JSON.parse(row.instructions)),
      }));

      return Response.json({
        recipes: parsed,
        meals: meals.results,
        extras: extras.results,
        checks: checks.results,
      } satisfies Household);
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
      yield* database(() =>
        db.batch([
          ...sampleRecipes.map((recipe) => recipeStatement(db, recipe)),
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
      try {
        const token = request.headers.get("Cf-Access-Jwt-Assertion");

        if (!token || !env.ACCESS_AUD) throw new Error("Missing Access credentials.");

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
            throw new Error("Unrecognized service identity.");
          }
        }
      } catch {
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
