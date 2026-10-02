import { Data, Effect } from "effect";
import { database } from "./storage";
import { parseRecipe, type RecipeRow } from "./recipes";
import { parseGrocery, type GroceryRow } from "./groceries";
import {
  matchIngredients,
  matchingFailureReason,
  normalizationModel,
  selectionModel,
} from "./ingredient-matching";

export class AiUnavailable extends Data.TaggedError("AiUnavailable")<{ message: string }> {}

export const matchGroceries = (db: D1Database, ai?: Ai, ray?: string | null) =>
  Effect.gen(function* () {
    const started = performance.now();
    const runId = crypto.randomUUID();
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

      return yield* new AiUnavailable({
        message:
          "AI ingredient matching requires a Cloudflare deployment with an AI binding. Local recipe saves still use exact matching.",
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

        // SAFETY: These fixed SELECTs return unbranded storage rows in this order.
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

    return { ok: true as const, report };
  });
