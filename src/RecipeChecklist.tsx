import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, displayAmount, matchesRecipeSearch, weekStart, type Household } from "./domain";
import { ingredientTotals } from "./ingredient-totals";
import { ShareLink } from "./ShareLink";
import "./recipe-checklist.css";

/** Combines one-batch source selections and scaled meal snapshots without changing household data. */
export function RecipeChecklist({
  recipes,
  groceries,
  meals,
  loaded,
  error,
  search,
  setSearch,
  selected,
  setSelected,
  selectedMeals,
  setSelectedMeals,
  showList,
  setShowList,
}: Pick<Household, "recipes" | "groceries" | "meals"> & {
  loaded: boolean;
  error: string;
  search: string;
  setSearch: (search: string) => void;
  selected: string[];
  setSelected: (selected: string[]) => void;
  selectedMeals: string[];
  setSelectedMeals: (selectedMeals: string[]) => void;
  showList: boolean;
  setShowList: (showList: boolean) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [week, setWeek] = useState(weekStart);
  const weekEnd = addDays(week, 6);

  const planned = meals.filter((meal) => meal.recipe && meal.date >= week && meal.date <= weekEnd);

  const chosen = recipes.filter((recipe) => selected.includes(recipe.id));

  const chosenMeals = meals.flatMap((meal) =>
    selectedMeals.includes(meal.id) && meal.recipe ? [{ meal, recipe: meal.recipe }] : [],
  );

  const rows = ingredientTotals({
    recipes: chosen,
    meals: chosenMeals.map(({ meal }) => meal),
    groceries,
  });

  const selectionCount = chosen.length + chosenMeals.length;
  const visible = recipes.filter((recipe) => matchesRecipeSearch(recipe, search));

  return (
    <main className="recipe-checklist">
      <header>
        <h1>Recipe checklist</h1>
        <a href="#recipes">Back to recipes</a> <ShareLink />
        <p className="muted">
          A separate checklist for one batch of each selected recipe and the planned servings of each selected
          meal. Nothing changes your shopping list or recipes. Selections can be shared. Checks reset when
          this tab reloads.
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
            {[
              ...chosen.map((recipe) => `${recipe.title} (${recipe.servings} servings)`),
              ...chosenMeals.map(
                ({ meal, recipe }) =>
                  `${recipe.title} (${recipe.servings * meal.scale} servings, ${meal.scale}×) — ${meal.date} ${meal.slot}`,
              ),
            ].join(" · ")}
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
          <section className="recipe-checklist-week" aria-label="Meal plan week">
            <strong>From your meal plan</strong>
            <div className="week-navigation">
              <button
                type="button"
                className="icon-button"
                aria-label="Previous week"
                onClick={() => setWeek(addDays(week, -7))}
              >
                <ChevronLeft size={17} />
              </button>
              <h2>
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).formatRange(new Date(`${week}T12:00:00`), new Date(`${weekEnd}T12:00:00`))}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Next week"
                onClick={() => setWeek(addDays(week, 7))}
              >
                <ChevronRight size={17} />
              </button>
            </div>
            <button
              type="button"
              className="secondary"
              disabled={!planned.length}
              onClick={() => {
                setSelected([]);
                setSelectedMeals(planned.map((meal) => meal.id));
                setChecked([]);
                setShowList(true);
              }}
            >
              {planned.length
                ? `Show this week’s ingredients (${planned.length} ${planned.length === 1 ? "meal" : "meals"})`
                : "No recipes planned this week"}
            </button>
          </section>
          {chosenMeals.length > 0 && (
            <div role="group" aria-label="Selected meals">
              {chosenMeals.map(({ meal, recipe }) => (
                <label className="recipe-checklist-row" key={meal.id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => setSelectedMeals(selectedMeals.filter((id) => id !== meal.id))}
                  />
                  <span>
                    <strong>{recipe.title}</strong>
                    <span className="muted small">
                      {meal.date} {meal.slot} · {recipe.servings * meal.scale} servings · {meal.scale}×
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
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
          <button className="primary" disabled={!selectionCount}>
            Show ingredients ({selectionCount} {selectionCount === 1 ? "recipe" : "recipes"})
          </button>
        </form>
      )}
    </main>
  );
}
