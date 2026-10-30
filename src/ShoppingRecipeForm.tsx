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
  type Ingredient,
  type ShoppingAddition,
  type ShoppingList,
  type ShoppingSource,
} from "./domain";
import { listName } from "./ShoppingLists";
import { ingredientTotals } from "./ingredient-totals";
import { matchGrocery } from "./groceries";

/**
 * Reviews planned meals' scaled ingredients (and unplanned recipes) against the list selected on the shopping tab. Items already on it
 * are never silently reset: checked or differently counted rows change only when explicitly ticked.
 */
export function ShoppingRecipeForm({
  recipes,
  meals,
  groceries,
  list,
  items,
  busy,
  error,
  cancel,
  save,
}: Pick<Household, "recipes" | "meals" | "groceries"> & {
  list: ShoppingList;
  items: Household["shoppingItems"];
  busy: boolean;
  error: string;
  cancel: () => void;
  save: (additions: ShoppingAddition[]) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [excluded, setExcluded] = useState<GroceryId[]>([]);
  const [packageCounts, setPackageCounts] = useState(new Map<GroceryId, string>());
  // Existing rows that conflict are only updated when ticked here.
  const [updates, setUpdates] = useState<GroceryId[]>([]);

  const stepHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    stepHeading.current?.focus();
  }, [reviewing]);

  const plannedIds = new Set(meals.filter((meal) => meal.recipe).map((meal) => meal.recipeId));

  const options = [
    ...meals.flatMap((meal) =>
      meal.recipe
        ? [
            {
              key: JSON.stringify(["meal", meal.id]),
              meal,
              recipe: meal.recipe,
              date: meal.date,
              slot: meal.slot,
              scale: meal.scale,
            },
          ]
        : [],
    ),
    ...recipes
      .filter((recipe) => !plannedIds.has(recipe.id))
      .map((recipe) => ({
        key: JSON.stringify(["recipe", recipe.id]),
        meal: undefined,
        recipe,
        date: "",
        slot: "",
        scale: 1,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const chosen = options.filter((option) => selected.includes(option.key));
  const ingredients = chosen.flatMap(({ recipe }) => recipe.ingredients);

  const linked = ingredientTotals({
    recipes: chosen.flatMap(({ recipe, meal }) => (meal ? [] : [recipe])),
    meals: chosen.flatMap(({ meal }) => (meal ? [meal] : [])),
    groceries,
  }).flatMap((row) => (row.grocery ? [{ ...row, item: row.grocery }] : []));

  const linkedId = (ingredient: Ingredient) =>
    ingredient.groceryItemId === undefined
      ? matchGrocery(ingredient.name, groceries)?.id
      : (ingredient.groceryItemId ?? undefined);

  // Record which chosen meals or recipes need each grocery, shown on the list row.
  const sourcesFor = (id: GroceryId): ShoppingSource[] =>
    chosen
      .filter(({ recipe }) => recipe.ingredients.some((ingredient) => linkedId(ingredient) === id))
      .map(({ recipe, meal }) =>
        meal ? { title: recipe.title, mealId: meal.id, date: meal.date } : { title: recipe.title },
      );

  const entries = new Map(
    items.filter((entry) => entry.listId === list.id).map((entry) => [entry.groceryId, entry]),
  );

  const countFor = (row: (typeof linked)[number]) =>
    packageCounts.get(row.item.id) ??
    (row.packages === null ? (entries.get(row.item.id)?.packages.toString() ?? "") : String(row.packages));

  const statusOf = (row: (typeof linked)[number]) => {
    const entry = entries.get(row.item.id);

    if (!entry) return "new" as const;

    return entry.checked || (row.packages !== null && row.packages !== entry.packages)
      ? ("conflict" as const)
      : ("same" as const);
  };

  const missing = linked.filter((row) => statusOf(row) === "new");
  const conflicts = linked.filter((row) => statusOf(row) === "conflict");
  const same = linked.filter((row) => statusOf(row) === "same");

  const toAdd = [
    ...missing.filter(
      (row) => !excluded.includes(row.item.id) && !(countFor(row).trim() && Number(countFor(row)) === 0),
    ),
    ...conflicts.filter((row) => updates.includes(row.item.id)),
  ].map((row) => ({ id: row.item.id, packages: Number(countFor(row)) }));

  const additions: ShoppingAddition[] = [
    ...toAdd.map(({ id, packages }) => ({
      groceryId: id,
      packages,
      sources: sourcesFor(id),
      // Ticked conflicts go back on as still needed, with the reviewed count.
      checked: 0 as const,
      replace: entries.has(id),
    })),
    // Matching rows only gain this shop's sources.
    ...same.map((row) => ({ groceryId: row.item.id, sources: sourcesFor(row.item.id) })),
  ];

  const listCounts = new Map<string, number>();

  for (const entry of items) listCounts.set(entry.listId, (listCounts.get(entry.listId) ?? 0) + 1);

  const invalidCounts = toAdd.filter(({ packages }) => !Schema.is(PackageCountSchema)(packages));
  const validCounts = invalidCounts.length === 0;

  const isLinked = (ingredient: Ingredient) =>
    ingredient.groceryItemId === undefined
      ? !!matchGrocery(ingredient.name, groceries)
      : groceries.some((grocery) => grocery.id === ingredient.groceryItemId);

  const unlinked = ingredients.filter((ingredient) => !isLinked(ingredient)).length;
  const needsLinking = chosen.filter(({ recipe }) => recipe.ingredients.some((item) => !isLinked(item)));

  const linkingHelp = needsLinking.some(({ meal }) => meal)
    ? needsLinking.some(({ meal }) => !meal)
      ? "Use Edit meal for planned meals and Edit recipe for unplanned recipes to link these ingredients."
      : "Open Edit meal to link these ingredients."
    : "Open Edit recipe to link these ingredients.";

  const blockedReason = busy
    ? "Adding items. Please wait."
    : reviewing
      ? !toAdd.length
        ? "Select at least one item with a quantity greater than zero to add."
        : !validCounts
          ? "Enter a whole-number quantity from 1 to 1,000,000 for each highlighted item, or unselect it. Use 0 to skip an item."
          : ""
      : !selected.length
        ? "Select at least one recipe to review its items."
        : !linked.length
          ? `No linked grocery items. ${linkingHelp}`
          : "";

  const visible = options.filter(({ recipe }) => matchesRecipeSearch(recipe, search));
  const weeks = new Map<string, typeof visible>();

  for (const option of visible) {
    const start = option.date ? weekStart(option.date) : "";
    const group = weeks.get(start);

    if (group) group.push(option);
    else weeks.set(start, [option]);
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
          if (!blockedReason) await save(additions);
        } else if (linked.length) {
          setReviewing(true);
        }
      }}
    >
      <div className="shopping-recipe-fields">
        <h3 ref={stepHeading} tabIndex={-1}>
          {reviewing ? "Review items" : "Choose recipes"}
        </h3>
        <div className="shopping-recipe-selection">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (reviewing) {
                setExcluded((current) => current.filter((id) => !missing.some((row) => row.item.id === id)));
              } else {
                setSelected(options.map((option) => option.key));
              }
            }}
          >
            Select all
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (reviewing) {
                setExcluded((current) => [...new Set([...current, ...missing.map((row) => row.item.id)])]);
              } else {
                setSelected([]);
              }
            }}
          >
            Unselect all
          </button>
        </div>
        {reviewing ? (
          <>
            <p className="muted small shopping-target">Adding to {listName(list)}</p>
            {conflicts.length > 0 && (
              <div className="shopping-recipe-options" role="group" aria-label="Already on this list">
                <h4 className="shopping-review-heading">Needs your decision · {conflicts.length}</h4>
                {conflicts.map((row) => (
                  <div
                    className={`shopping-review-item conflict${invalidCounts.some((item) => item.id === row.item.id) ? " needs-quantity" : ""}`}
                    key={row.item.id}
                  >
                    <label className="shopping-recipe-option">
                      <input
                        type="checkbox"
                        checked={updates.includes(row.item.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setUpdates((current) =>
                            event.target.checked
                              ? [...current, row.item.id]
                              : current.filter((id) => id !== row.item.id),
                          )
                        }
                      />
                      <span>
                        <strong>{row.item.name}</strong>
                        <span className="shopping-review-conflict small">
                          {entries.get(row.item.id)?.checked
                            ? "Already picked up on this list. Tick to put it back on as still needed."
                            : `On this list as ${entries.get(row.item.id)?.packages ?? 1}. Tick to change the count.`}
                        </span>
                        <span className="small">
                          Recipes need {row.amounts.map(displayAmount).join(" + ")}
                        </span>
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
                        disabled={busy || !updates.includes(row.item.id)}
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
            )}
            <div className="shopping-recipe-options" role="group" aria-label="Items to add">
              {missing.length > 0 && conflicts.length > 0 && (
                <h4 className="shopping-review-heading">New for this list · {missing.length}</h4>
              )}
              {missing.map((row) => (
                <div
                  className={`shopping-review-item${invalidCounts.some((item) => item.id === row.item.id) ? " needs-quantity" : ""}`}
                  key={row.item.id}
                >
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
              {!missing.length && (
                <p className="muted">Everything from these meals is already on this list.</p>
              )}
            </div>
          </>
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
                  {weekRecipes.map(({ key, recipe, date, slot, scale }) => (
                    <label className="shopping-recipe-option" key={key}>
                      <input
                        type="checkbox"
                        checked={selected.includes(key)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked ? [...current, key] : current.filter((id) => id !== key),
                          )
                        }
                      />
                      <span>
                        <strong>{recipe.title}</strong>
                        {date && (
                          <span className="muted small">
                            {date} · {slot} · {scale}×
                          </span>
                        )}
                        <span className="muted small">
                          {recipe.ingredients.filter(isLinked).length} of {recipe.ingredients.length}{" "}
                          ingredients linked
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
              : `selected · ${linked.length} linked ${linked.length === 1 ? "grocery" : "groceries"}`}
          </strong>
          {reviewing && same.length > 0 && (
            <p className="muted">
              {same.length} already on this list with the same count. Untick anything you already have at
              home.
            </p>
          )}
          {unlinked > 0 && (
            <p className="muted">
              {unlinked} unlinked {unlinked === 1 ? "ingredient will" : "ingredients will"} be skipped.{" "}
              {linkingHelp}
            </p>
          )}
          {selected.length > 0 && !linked.length && <p className="muted">No linked grocery items.</p>}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <div className="form-actions">
        {blockedReason && (
          <p id="shopping-recipe-blocked" className="shopping-recipe-blocked muted small" role="status">
            {blockedReason}
          </p>
        )}
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
          disabled={!!blockedReason}
          aria-describedby={blockedReason ? "shopping-recipe-blocked" : undefined}
          title={blockedReason || undefined}
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
