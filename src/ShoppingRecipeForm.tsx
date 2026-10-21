import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import {
  addDays,
  displayAmount,
  matchesRecipeSearch,
  PackageCountSchema,
  weekStart,
  type GroceryId,
  type Household,
} from "./domain";
import { ingredientTotals } from "./ingredient-totals";

/** Groups recipes by their latest planned Saturday–Friday week before reviewing linked groceries. */
export function ShoppingRecipeForm({
  recipes,
  meals,
  groceries,
  checks,
  busy,
  error,
  cancel,
  save,
}: Pick<Household, "recipes" | "meals" | "groceries" | "checks"> & {
  busy: boolean;
  error: string;
  cancel: () => void;
  save: (items: { id: GroceryId; packages: number }[]) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [excluded, setExcluded] = useState<GroceryId[]>([]);
  const [packageCounts, setPackageCounts] = useState(new Map<GroceryId, string>());
  const stepHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    stepHeading.current?.focus();
  }, [reviewing]);

  const plannedDates = new Map<string, string>();

  for (const meal of meals) {
    if (meal.recipeId && meal.date > (plannedDates.get(meal.recipeId) ?? "")) {
      plannedDates.set(meal.recipeId, meal.date);
    }
  }

  const orderedRecipes = [...recipes].sort((a, b) =>
    (plannedDates.get(b.id) ?? "").localeCompare(plannedDates.get(a.id) ?? ""),
  );

  const ingredients = recipes
    .filter((recipe) => selected.includes(recipe.id))
    .flatMap((recipe) => recipe.ingredients);

  const linked = ingredientTotals({
    recipes: recipes
      .filter((recipe) => selected.includes(recipe.id))
      .map((recipe) => ({
        ...recipe,
        ingredients: recipe.ingredients.filter((ingredient) => ingredient.groceryItemId),
      })),
    groceries,
  }).flatMap((row) => (row.grocery ? [{ ...row, item: row.grocery }] : []));

  const onList = new Set(checks.filter((entry) => entry.checked === 0).map((entry) => entry.key));
  const missing = linked.filter(({ item }) => !onList.has(JSON.stringify(["shopping-list", item.id])));

  const countFor = (row: (typeof missing)[number]) =>
    packageCounts.get(row.item.id) ?? (row.packages === null ? "" : String(row.packages));

  const toAdd = missing
    .filter(
      (row) => !excluded.includes(row.item.id) && !(countFor(row).trim() && Number(countFor(row)) === 0),
    )
    .map((row) => ({ id: row.item.id, packages: Number(countFor(row)) }));

  const validCounts = toAdd.every(({ packages }) => Schema.is(PackageCountSchema)(packages));

  const unlinked = ingredients.filter((ingredient) => !ingredient.groceryItemId).length;
  const visible = orderedRecipes.filter((recipe) => matchesRecipeSearch(recipe, search));
  const weeks = new Map<string, typeof visible>();

  for (const recipe of visible) {
    const planned = plannedDates.get(recipe.id);
    const start = planned ? weekStart(planned) : "";
    const group = weeks.get(start);

    if (group) group.push(recipe);
    else weeks.set(start, [recipe]);
  }

  const weekDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const weekEndDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <form
      className="modal-form shopping-recipe-form"
      onSubmit={async (event) => {
        event.preventDefault();

        if (busy) return;

        if (reviewing) {
          if (toAdd.length && validCounts) await save(toAdd);
        } else if (missing.length) {
          setReviewing(true);
        }
      }}
    >
      <div className="shopping-recipe-fields">
        <h3 ref={stepHeading} tabIndex={-1}>
          {reviewing ? "Review items" : "Choose recipes"}
        </h3>
        {reviewing ? (
          <div className="shopping-recipe-options" role="group" aria-label="Items to add">
            {missing.map((row) => (
              <div className="shopping-review-item" key={row.item.id}>
                <label className="shopping-recipe-option">
                  <input
                    type="checkbox"
                    checked={!excluded.includes(row.item.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setExcluded((current) =>
                        event.target.checked
                          ? current.filter((id) => id !== row.item.id)
                          : [...current, row.item.id],
                      )
                    }
                  />
                  <span>
                    <strong>{row.item.name}</strong>
                    <span className="small">Recipes need {row.amounts.map(displayAmount).join(" + ")}</span>
                    <span className="muted small">{displayAmount(row.item)} per package</span>
                  </span>
                </label>
                <label className="shopping-package-count">
                  Packages to buy
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1_000_000}
                    step={1}
                    required
                    aria-label={`Packages to buy for ${row.item.name}`}
                    value={countFor(row)}
                    disabled={busy || excluded.includes(row.item.id)}
                    onChange={(event) =>
                      setPackageCounts((current) => new Map(current).set(row.item.id, event.target.value))
                    }
                  />
                </label>
                {row.packages === null && (
                  <p className="muted small">
                    These units can’t be converted to this package. Choose how many to buy.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            <label>
              Search recipes
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="shopping-recipe-options" role="group" aria-label="Recipes to shop for">
              {[...weeks].map(([start, weekRecipes]) => (
                <section
                  className="shopping-recipe-week"
                  key={start}
                  aria-labelledby={`recipe-week-${start}`}
                >
                  <h4 className="shopping-recipe-week-heading" id={`recipe-week-${start}`}>
                    <span>
                      {start ? (
                        <>
                          <span>{weekDate.format(new Date(`${start}T12:00:00`))}</span>
                          <span>– {weekEndDate.format(new Date(`${addDays(start, 6)}T12:00:00`))}</span>
                        </>
                      ) : (
                        "Not yet planned"
                      )}
                    </span>
                  </h4>
                  {weekRecipes.map((recipe) => (
                    <label className="shopping-recipe-option" key={recipe.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(recipe.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, recipe.id]
                              : current.filter((id) => id !== recipe.id),
                          )
                        }
                      />
                      <span>
                        <strong>{recipe.title}</strong>
                        <span className="muted small">
                          {recipe.ingredients.filter((ingredient) => ingredient.groceryItemId).length} of{" "}
                          {recipe.ingredients.length} ingredients linked
                        </span>
                      </span>
                    </label>
                  ))}
                </section>
              ))}
              {!visible.length && (
                <p className="muted">
                  {recipes.length ? "No recipes match your search." : "No recipes yet."}
                </p>
              )}
            </div>
          </>
        )}
        <div className="shopping-recipe-preview" aria-live="polite">
          <strong>
            {reviewing ? toAdd.length : selected.length}{" "}
            {reviewing
              ? `${toAdd.length === 1 ? "item" : "items"} to add`
              : `selected · ${missing.length} ${missing.length === 1 ? "item" : "items"} to add`}
          </strong>
          {linked.length > missing.length && (
            <p className="muted">{linked.length - missing.length} already on your list.</p>
          )}
          {unlinked > 0 && (
            <p className="muted">
              {unlinked} unlinked {unlinked === 1 ? "ingredient will" : "ingredients will"} be skipped. Link
              them in the recipe editor to include them.
            </p>
          )}
          {selected.length > 0 && !missing.length && (
            <p className="muted">
              {linked.length
                ? "All linked items are already on your list."
                : "These recipes have no linked grocery items."}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {reviewing && (
          <button type="button" className="secondary" disabled={busy} onClick={() => setReviewing(false)}>
            Back
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !(reviewing ? toAdd.length && validCounts : missing.length)}
        >
          {busy
            ? "Adding…"
            : reviewing
              ? `Add ${toAdd.length} ${toAdd.length === 1 ? "item" : "items"}`
              : "Review items"}
        </button>
      </div>
    </form>
  );
}
