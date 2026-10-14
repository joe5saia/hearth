import { useEffect, useRef, useState } from "react";
import { matchesRecipeSearch, type GroceryId, type Household } from "./domain";

/** Reviews linked groceries from planned recipes before delegating additions to the caller. */
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
  save: (ids: GroceryId[]) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [excluded, setExcluded] = useState<GroceryId[]>([]);
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

  const plannedRecipes = recipes
    .flatMap((recipe) => {
      const date = plannedDates.get(recipe.id);

      return date === undefined ? [] : [{ recipe, date }];
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ recipe }) => recipe);

  const ingredients = recipes
    .filter((recipe) => selected.includes(recipe.id))
    .flatMap((recipe) => recipe.ingredients);

  const linkedIds = new Set(
    ingredients.flatMap((ingredient) => (ingredient.groceryItemId ? [ingredient.groceryItemId] : [])),
  );

  const linked = groceries.filter((item) => linkedIds.has(item.id));
  const onList = new Set(checks.filter((entry) => entry.checked === 0).map((entry) => entry.key));
  const missing = linked.filter((item) => !onList.has(JSON.stringify(["shopping-list", item.id])));
  const toAdd = missing.filter((item) => !excluded.includes(item.id));
  const unlinked = ingredients.filter((ingredient) => !ingredient.groceryItemId).length;
  const visible = plannedRecipes.filter((recipe) => matchesRecipeSearch(recipe, search));

  return (
    <form
      className="modal-form shopping-recipe-form"
      onSubmit={async (event) => {
        event.preventDefault();

        if (busy) return;

        if (reviewing) {
          if (toAdd.length) await save(toAdd.map((item) => item.id));
        } else if (missing.length) {
          setReviewing(true);
        }
      }}
    >
      <h3 ref={stepHeading} tabIndex={-1}>
        {reviewing ? "Review items" : "Choose recipes"}
      </h3>
      <p className="muted">
        {reviewing
          ? "Uncheck anything you already have. Shared items appear once; items already on your list stay unchanged."
          : "Choose meal-plan recipes, latest planned date first, to add their linked grocery items. Items already on your list stay unchanged."}
      </p>
      {reviewing ? (
        <div className="shopping-recipe-options" role="group" aria-label="Items to add">
          {missing.map((item) => (
            <label className="shopping-recipe-option shopping-review-item" key={item.id}>
              <input
                type="checkbox"
                checked={!excluded.includes(item.id)}
                disabled={busy}
                onChange={(event) =>
                  setExcluded((current) =>
                    event.target.checked ? current.filter((id) => id !== item.id) : [...current, item.id],
                  )
                }
              />
              <span>
                <strong>{item.name}</strong>
              </span>
            </label>
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
            {visible.map((recipe) => (
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
            {!visible.length && (
              <p className="muted">
                {plannedRecipes.length
                  ? "No recipes match your search."
                  : "No recipes in your meal plan yet. Plan a recipe to add its linked grocery items here."}
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
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {reviewing && (
          <button type="button" className="secondary" disabled={busy} onClick={() => setReviewing(false)}>
            Back
          </button>
        )}
        <button className="primary" disabled={busy || !(reviewing ? toAdd.length : missing.length)}>
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
