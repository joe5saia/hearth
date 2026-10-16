import { useState } from "react";
import { displayAmount, matchesRecipeSearch, type Household } from "./domain";
import { ingredientTotals } from "./ingredient-totals";
import { ShareLink } from "./ShareLink";
import "./recipe-checklist.css";

/** Keeps recipe selections and ingredient checks in component memory without changing household data. */
export function RecipeChecklist({
  recipes,
  groceries,
  loaded,
  error,
  search,
  setSearch,
  selected,
  setSelected,
  showList,
  setShowList,
}: Pick<Household, "recipes" | "groceries"> & {
  loaded: boolean;
  error: string;
  search: string;
  setSearch: (search: string) => void;
  selected: string[];
  setSelected: (selected: string[]) => void;
  showList: boolean;
  setShowList: (showList: boolean) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const chosen = recipes.filter((recipe) => selected.includes(recipe.id));
  const rows = ingredientTotals({ recipes: chosen, groceries });
  const visible = recipes.filter((recipe) => matchesRecipeSearch(recipe, search));

  return (
    <main className="recipe-checklist">
      <header>
        <h1>Recipe checklist</h1>
        <a href="#recipes">Back to recipes</a> <ShareLink />
        <p className="muted">
          A separate checklist for one batch of each recipe. Nothing changes your shopping list or recipes.
          Recipe selections can be shared. Checks reset when this tab reloads.
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
            {rows.filter((row) => !checked.includes(row.key)).length} of {rows.length} items left
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
                    setSelected(
                      event.target.checked
                        ? [...selected, recipe.id]
                        : selected.filter((id) => id !== recipe.id),
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
