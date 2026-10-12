import { useState } from "react";
import { displayAmount, matchesRecipeSearch, type Household, type ShoppingNeed, type Unit } from "./domain";
import { matchGrocery } from "./groceries";
import "./recipe-checklist.css";

// US customary volume; oz is weight, not fluid ounces. Counts only combine with the same unit.
const conversions: Partial<Record<Unit, { base: Unit; factor: number }>> = {
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  oz: { base: "g", factor: 28.349523125 },
  lb: { base: "g", factor: 453.59237 },
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  tsp: { base: "ml", factor: 4.92892159375 },
  tbsp: { base: "ml", factor: 14.78676478125 },
  cup: { base: "ml", factor: 236.5882365 },
};

function conversion(unit: Unit) {
  return conversions[unit] ?? { base: unit, factor: 1 };
}

function ingredientTotals({ recipes, groceries }: Pick<Household, "recipes" | "groceries">) {
  const rows = new Map<
    string,
    { key: string; name: string; unit: Unit; amounts: Map<Unit, number>; recipes: Set<string> }
  >();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const grocery = ingredient.groceryItemId
        ? groceries.find((item) => item.id === ingredient.groceryItemId)
        : ingredient.groceryItemId === undefined
          ? matchGrocery(ingredient.name, groceries)
          : undefined;

      const name = grocery?.name ?? ingredient.name.trim();

      const key = JSON.stringify(
        grocery ? ["grocery", grocery.id] : ["ingredient", name.replace(/\s+/g, " ").toLowerCase()],
      );

      const row = rows.get(key) ?? {
        key,
        name,
        unit: grocery?.unit ?? ingredient.unit,
        amounts: new Map<Unit, number>(),
        recipes: new Set<string>(),
      };

      const { base, factor } = conversion(ingredient.unit);
      row.amounts.set(base, (row.amounts.get(base) ?? 0) + ingredient.quantity * factor);
      row.recipes.add(recipe.title);
      rows.set(key, row);
    }
  }

  return [...rows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => {
      const preferred = conversion(row.unit);

      const amounts: ShoppingNeed[] = [...row.amounts].map(([base, total]) => ({
        name: row.name,
        quantity: base === preferred.base ? total / preferred.factor : total,
        unit: base === preferred.base ? row.unit : base,
      }));

      return { ...row, amounts };
    });
}

export function RecipeChecklist({
  recipes,
  groceries,
  loaded,
  error,
}: Pick<Household, "recipes" | "groceries"> & { loaded: boolean; error: string }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [showList, setShowList] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const chosen = recipes.filter((recipe) => selected.includes(recipe.id));
  const rows = ingredientTotals({ recipes: chosen, groceries });
  const visible = recipes.filter((recipe) => matchesRecipeSearch(recipe, search));

  return (
    <main className="recipe-checklist">
      <header>
        <h1>Recipe checklist</h1>
        <p className="muted">
          A separate checklist for one batch of each recipe. Nothing changes your shopping list or recipes.
          Selections and checks reset when this tab reloads.
        </p>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !loaded ? (
        <p role="status">Loading recipes…</p>
      ) : showList ? (
        <>
          <button className="secondary" onClick={() => setShowList(false)}>
            Change recipes
          </button>
          <p className="muted">
            {chosen.map((recipe) => `${recipe.title} (${recipe.servings} servings)`).join(" · ")}
          </p>
          <p role="status">
            {rows.length - checked.length} of {rows.length} items left
          </p>
          {rows.some((row) => row.amounts.length > 1) && (
            <p className="muted small">
              Some items have separate totals: weight, volume, and counts can’t be converted without more
              information.
            </p>
          )}
          <div aria-label="Ingredients needed">
            {rows.map((row) => (
              <label className="recipe-checklist-row" key={row.key}>
                <input
                  type="checkbox"
                  checked={checked.includes(row.key)}
                  onChange={(event) =>
                    setChecked((current) =>
                      event.target.checked ? [...current, row.key] : current.filter((key) => key !== row.key),
                    )
                  }
                />
                <span>
                  <strong>{row.name}</strong>
                  <span>{row.amounts.map(displayAmount).join(" + ")}</span>
                  <span className="muted small">{[...row.recipes].join(" · ")}</span>
                </span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setChecked([]);
            setShowList(true);
          }}
        >
          <label className="recipe-checklist-search">
            Search recipes
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div role="group" aria-label="Recipes to shop for">
            {visible.map((recipe) => (
              <label className="recipe-checklist-row" key={recipe.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(recipe.id)}
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
                    {recipe.servings} servings · {recipe.ingredients.length}{" "}
                    {recipe.ingredients.length === 1 ? "ingredient" : "ingredients"}
                  </span>
                </span>
              </label>
            ))}
            {!visible.length && (
              <p className="muted">
                {recipes.length
                  ? "No recipes match your search."
                  : "No recipes yet. Add recipes to make a checklist."}
              </p>
            )}
          </div>
          <button className="primary" disabled={!selected.length}>
            Show ingredients ({selected.length} {selected.length === 1 ? "recipe" : "recipes"})
          </button>
        </form>
      )}
    </main>
  );
}
