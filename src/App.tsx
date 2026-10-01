import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Option, Schema } from "effect";
import { KitchenTimers } from "./KitchenTimers";
import { GroceryForm, GroceryManager } from "./GroceryManager";
import { ShoppingItems } from "./ShoppingItems";
import { matchGrocery } from "./groceries";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CookingPot,
  Leaf,
  Plus,
  Search,
  ShoppingBasket,
  SlidersHorizontal,
  Sprout,
  Trash2,
  ThumbsDown,
  ThumbsUp,
  Minus,
  Users,
  X,
  ExternalLink,
  Pencil,
  Package,
} from "lucide-react";
import {
  addDays,
  checkKey,
  dateKey,
  displayAmount,
  purchaseAmount,
  quantity,
  shoppingList,
  units,
  weekStart,
  nextDinnerDate,
  validDate,
  matchesRecipeSearch,
  RecipeSchema,
  HouseholdSchema,
  type Household,
  type Collection,
  type Ingredient,
  type Meal,
  type Recipe,
  type Rating,
  type GroceryItem,
  type ShoppingOrder,
} from "./domain";

type Page = "plan" | "recipes" | "shopping" | "groceries";

type Modal =
  | { kind: "collections" }
  | { kind: "grocery"; item: GroceryItem }
  | { kind: "collection"; collection: Collection }
  | { kind: "meal"; meal: Meal }
  | { kind: "recipe"; recipe: Recipe; meal?: Meal }
  | { kind: "import" }
  | { kind: "editor"; recipe: Recipe; warnings?: readonly string[] };

const emptyHousehold: Household = {
  collections: [],
  recipes: [],
  meals: [],
  extras: [],
  checks: [],
  groceries: [],
  shoppingOrder: { aisles: [], items: [] },
};

const newGrocery = (name = "", unit = "each"): GroceryItem => ({
  id: crypto.randomUUID(),
  name,
  unit,
  quantity: 1,
  url: "",
  aisle: "",
  aliases: name ? [name] : [],
});

const readableDate = (
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" },
) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", options);

const pageFromHash = (): Page =>
  location.hash === "#recipes"
    ? "recipes"
    : location.hash === "#shopping"
      ? "shopping"
      : location.hash === "#groceries"
        ? "groceries"
        : "plan";

async function api(
  path: string,
  method = "GET",
  body?:
    | Recipe
    | Collection
    | Meal
    | GroceryItem
    | ShoppingOrder
    | { url: string }
    | { id: string; name: string; checked: number }
    | { key: string; checked: number }
    | { rating: Rating },
) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);

  const response = await fetch(`/api/${path}`, init);

  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(
      await response.json().catch(() => null),
    );

    throw new Error(Option.isSome(failure) ? failure.value.error : "We couldn’t connect. Please try again.");
  }

  return response;
}

function Photo({ recipe, className = "" }: { recipe: Recipe; className?: string }) {
  const [failed, setFailed] = useState("");
  const [loaded, setLoaded] = useState("");

  return (
    <div className={`photo-placeholder ${className}`}>
      <CookingPot size={32} aria-hidden="true" />
      {recipe.photo && failed !== recipe.photo && (
        <img
          key={recipe.photo}
          className={loaded === recipe.photo ? "photo-loaded" : ""}
          src={recipe.photo}
          alt={recipe.title}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onLoad={() => setLoaded(recipe.photo)}
          onError={() => setFailed(recipe.photo)}
        />
      )}
    </div>
  );
}

function Dialog({
  title,
  close,
  children,
  wide = false,
  fullScreen = false,
  timerHost,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  fullScreen?: boolean;
  timerHost?: (element: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const scrollY = window.scrollY;
    const bodyStyle = document.body.style.cssText;

    if (fullScreen) {
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = "100%";
      document.body.style.overflow = "hidden";
    }

    dialog?.showModal();

    return () => {
      dialog?.close();

      if (fullScreen) {
        document.body.style.cssText = bodyStyle;
        window.scrollTo({ top: scrollY, behavior: "instant" });
      }
    };
  }, [fullScreen]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal${wide ? " wide" : ""}${fullScreen ? " fullscreen" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (!fullScreen && event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        {timerHost && <div className="timer-slot" ref={timerHost} />}
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [data, setData] = useState<Household>(emptyHousehold);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useState(weekStart());
  const [modal, setModal] = useState<Modal | null>(null);
  const [search, setSearch] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [start, setStart] = useState(weekStart());
  const [end, setEnd] = useState(addDays(weekStart(), 6));
  const [extra, setExtra] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [shoppingMode, setShoppingMode] = useState(false);
  const [timerHeaderHost, setTimerHeaderHost] = useState<HTMLDivElement | null>(null);
  const [timerDialogHost, setTimerDialogHost] = useState<HTMLDivElement | null>(null);
  const weekInput = useRef<HTMLInputElement>(null);
  const topbar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const header = topbar.current;

    if (!header) return;

    const observer = new ResizeObserver(() => {
      header.parentElement?.style.setProperty(
        "--app-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    });

    observer.observe(header);

    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    const response = await api("household");
    setData(Schema.decodeUnknownSync(HouseholdSchema)(await response.json()));
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh().catch((failure: Error) => setError(failure.message));
  }, [refresh]);
  useEffect(() => {
    const sync = () => setPage(pageFromHash());
    window.addEventListener("hashchange", sync);

    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);

    return () => clearTimeout(timer);
  }, [toast]);

  const navigate = (next: Page) => {
    location.hash = next;
    setPage(next);
    setError("");
  };

  const mutate = async (
    path: string,
    method: string,
    body: Parameters<typeof api>[2],
    message = "",
    close = false,
  ) => {
    setBusy(true);
    setError("");

    try {
      await api(path, method, body);
      await refresh();

      if (close) setModal(null);

      if (message) setToast(message);

      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Please try again.");

      return false;
    } finally {
      setBusy(false);
    }
  };

  const addMeal = (date = nextDinnerDate(data.meals, week), recipeId = data.recipes[0]?.id ?? "") =>
    setModal({
      kind: "meal",
      meal: { id: crypto.randomUUID(), recipeId, date, slot: "Dinner", scale: 1, note: "" },
    });

  const newRecipe = () =>
    setModal({
      kind: "editor",
      recipe: {
        id: crypto.randomUUID(),
        title: "",
        description: "",
        servings: 4,
        minutes: 30,
        category: data.collections.find((collection) => collection.id === collectionFilter)?.name ?? "",
        photo: "",
        source: "",
        rating: "neutral",
        ingredients: [{ name: "", quantity: 1, unit: "each" }],
        instructions: [""],
      },
    });

  const weekMeals = data.meals.filter((meal) => meal.date >= week && meal.date <= addDays(week, 6));

  const selectedCollection = data.collections.find((collection) => collection.id === collectionFilter);

  const matchingRecipes = data.recipes.filter(
    (recipe) =>
      matchesRecipeSearch(recipe, search) &&
      (collectionFilter === "uncollected"
        ? !recipe.category
        : !selectedCollection || recipe.category === selectedCollection.name),
  );

  const items = useMemo(
    () => shoppingList(data.recipes, data.meals, start, end, data.groceries, data.shoppingOrder),
    [data.recipes, data.meals, start, end, data.groceries, data.shoppingOrder],
  );

  const isChecked = (key: string) => data.checks.some((entry) => entry.key === key && entry.checked === 1);
  const completed = items.filter((item) => isChecked(checkKey(item, start, end))).length;
  const totalItems = items.length + data.extras.length;
  const totalCompleted = completed + data.extras.filter((item) => item.checked).length;
  const rangeMeals = data.meals.filter((meal) => meal.date >= start && meal.date <= end);

  const exportList = () => {
    const text = [
      `Hearth shopping list · ${start} to ${end}`,
      "",
      ...items.map(
        (item) =>
          `${isChecked(checkKey(item, start, end)) ? "[x]" : "[ ]"} ${item.grocery?.aisle ? `[Aisle ${item.grocery.aisle}] ` : ""}${item.name} — ${purchaseAmount(item)}; need ${item.needs.map(displayAmount).join(" + ")}${item.warnings.length ? `\n  WARNING: ${item.warnings.join(" ")}` : ""}`,
      ),
      "",
      "Household extras",
      ...data.extras.map((item) => `${item.checked ? "[x]" : "[ ]"} ${item.name}`),
      "",
      "Meal notes (not included in ingredient totals)",
      ...rangeMeals.flatMap((meal) => (meal.note ? [`${meal.date}: ${meal.note}`] : [])),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hearth-shopping-${start}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`app-shell${page === "shopping" && shoppingMode ? " shopping-mode" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="#plan" aria-label="Hearth meal plan">
          <img src="/brand/logo.svg" alt="Hearth" width="184" height="50" />
        </a>
        <nav aria-label="Main navigation">
          <a
            href="#plan"
            aria-current={page === "plan" ? "page" : undefined}
            className={page === "plan" ? "active" : ""}
          >
            <CalendarDays size={19} /> Meal plan <span className="nav-dot" />
          </a>
          <a
            href="#recipes"
            aria-current={page === "recipes" ? "page" : undefined}
            className={page === "recipes" ? "active" : ""}
          >
            <BookOpen size={19} /> Recipes <span className="nav-count">{data.recipes.length}</span>
          </a>
          <a
            href="#shopping"
            aria-current={page === "shopping" ? "page" : undefined}
            className={page === "shopping" ? "active" : ""}
          >
            <ShoppingBasket size={19} /> Shopping list
          </a>
          <a
            href="#groceries"
            aria-current={page === "groceries" ? "page" : undefined}
            className={page === "groceries" ? "active" : ""}
          >
            <Package size={19} /> Grocery items
          </a>
        </nav>
      </aside>
      <main>
        <div className="topbar" ref={topbar}>
          <a className="mobile-brand" href="#plan" aria-label="Hearth meal plan">
            <picture>
              <source media="(min-width: 601px)" srcSet="/brand/icon-small.svg" />
              <img src="/brand/logo.svg" alt="Hearth" width="136" height="37" />
            </picture>
          </a>
          <div className="timer-slot" ref={setTimerHeaderHost} />
          <button
            className="secondary"
            onClick={() => {
              setError("");
              setModal({ kind: "import" });
            }}
          >
            <ArrowDownToLine size={16} /> Import recipe
          </button>
        </div>
        {error && !modal && (
          <div className="error" role="alert">
            {error}{" "}
            <button
              onClick={() => {
                setError("");
                refresh().catch((failure: Error) => setError(failure.message));
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!loaded ? (
          <div className="empty-state">
            <CookingPot size={40} />
            <h2>{error ? "Let’s reconnect" : "Setting the table…"}</h2>
            <p>{error || "Your recipes and plans will be right here."}</p>
          </div>
        ) : (
          <>
            <header className={`page-heading ${page === "plan" ? "plan-heading" : ""}`}>
              <div>
                <h1>
                  {page === "plan"
                    ? "Meal Plan"
                    : page === "recipes"
                      ? "Recipes"
                      : page === "groceries"
                        ? "Grocery items"
                        : "Shopping list"}
                </h1>
              </div>
              {page === "plan" ? (
                <button className="primary" onClick={() => (data.recipes.length ? addMeal() : newRecipe())}>
                  <Plus size={17} /> Add a meal
                </button>
              ) : page === "recipes" ? (
                <button className="primary" onClick={newRecipe}>
                  <Plus size={17} /> Add a recipe
                </button>
              ) : page === "shopping" ? (
                <button className="secondary" onClick={exportList}>
                  <ArrowDownToLine size={17} /> Export list
                </button>
              ) : null}
            </header>
            {page === "groceries" && (
              <GroceryManager
                groceries={data.groceries}
                recipes={data.recipes}
                busy={busy}
                add={() => setModal({ kind: "grocery", item: newGrocery() })}
                edit={(item) => setModal({ kind: "grocery", item })}
                editRecipe={(recipe) => setModal({ kind: "editor", recipe })}
                match={() => mutate("groceries/match", "POST", undefined, "Ingredient matches updated")}
              />
            )}
            {data.recipes.length === 0 && (
              <section className="welcome">
                <Sprout size={36} />
                <div>
                  <h2>Welcome to your everyday table.</h2>
                  <p>Start with a family favorite, or explore a sample week with six recipes.</p>
                </div>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      `demo?today=${dateKey(new Date())}`,
                      "POST",
                      undefined,
                      "Your sample week is ready",
                    )
                  }
                >
                  Try a sample week <ArrowRight size={16} />
                </button>
              </section>
            )}
            {page === "plan" && (
              <>
                <div className="section-toolbar">
                  <div className="week-navigation">
                    <div className="button-group">
                      <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>
                        <ChevronLeft size={17} />
                      </button>
                      <button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}>
                        <ChevronRight size={17} />
                      </button>
                    </div>
                    <h2>
                      {readableDate(week, { month: "short", day: "numeric" })}
                      {week.slice(0, 4) !== addDays(week, 6).slice(0, 4) && <span>, {week.slice(0, 4)}</span>}
                      {" – "}
                      {readableDate(addDays(week, 6), { month: "short", day: "numeric" })}
                      <span>, {addDays(week, 6).slice(0, 4)}</span>
                    </h2>
                    <button className="today-button" onClick={() => setWeek(weekStart())}>
                      This week
                    </button>
                  </div>
                  <span className="muted small">
                    <span className="olive-dot" /> {weekMeals.length} meals planned{" "}
                    <span className="toolbar-separator">|</span>{" "}
                    {new Set(weekMeals.map((meal) => meal.date)).size} of 7 days
                  </span>
                </div>
                <details className="date-disclosure">
                  <summary>
                    <CalendarDays size={16} /> Jump to date <ChevronDown size={16} />
                  </summary>
                  <form
                    className="week-jump"
                    key={week}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const date = weekInput.current?.value;

                      if (date && validDate(date)) setWeek(weekStart(date));
                    }}
                  >
                    <label htmlFor="week-jump">
                      <CalendarDays size={16} /> Jump to date
                    </label>
                    <input
                      id="week-jump"
                      ref={weekInput}
                      type="date"
                      required
                      aria-label="Jump to week containing date"
                      defaultValue={week}
                    />
                    <button className="today-button">Go</button>
                  </form>
                </details>
                <div className="calendar">
                  {Array.from({ length: 7 }, (_, index) => {
                    const day = addDays(week, index);

                    const meals = weekMeals
                      .filter((meal) => meal.date === day)
                      .sort(
                        (a, b) =>
                          ["Breakfast", "Lunch", "Dinner"].indexOf(a.slot) -
                          ["Breakfast", "Lunch", "Dinner"].indexOf(b.slot),
                      );

                    const today = day === dateKey(new Date());

                    return (
                      <section
                        className={`day ${today ? "is-today" : ""}`}
                        key={day}
                        aria-label={readableDate(day, { weekday: "long", month: "long", day: "numeric" })}
                      >
                        <div className="day-heading">
                          <span>{readableDate(day, { weekday: "short" })}</span>
                          <span className="day-number">{Number(day.slice(-2))}</span>
                          {today && <small>Today</small>}
                        </div>
                        <div className="day-meals">
                          {meals.map((meal) => {
                            const recipe = data.recipes.find((entry) => entry.id === meal.recipeId);

                            if (!recipe) return null;

                            return (
                              <button
                                className="meal-card"
                                key={meal.id}
                                onClick={() => setModal({ kind: "meal", meal })}
                              >
                                <div className="meal-photo">
                                  <Photo recipe={recipe} />
                                  <span className="meal-slot">{meal.slot}</span>
                                </div>
                                <div className="meal-content">
                                  <h3>{recipe.title}</h3>
                                  <div className="meal-meta">
                                    <Users size={12} /> {quantity(recipe.servings * meal.scale)} servings{" "}
                                    {meal.scale !== 1 && <span>{quantity(meal.scale)}×</span>}
                                  </div>
                                  {meal.note && <p className="meal-note">{meal.note}</p>}
                                </div>
                              </button>
                            );
                          })}
                          {meals.length === 0 && (
                            <div className="open-day">
                              <Leaf size={23} strokeWidth={1} />
                              <p>
                                A little room
                                <br />
                                for spontaneity
                              </p>
                            </div>
                          )}
                          <button
                            className="add-day"
                            aria-label={`Add meal for ${readableDate(day)}`}
                            onClick={() => (data.recipes.length ? addMeal(day) : newRecipe())}
                          >
                            <Plus size={15} />
                            <span>Add meal</span>
                          </button>
                        </div>
                      </section>
                    );
                  })}
                </div>
                <div className="plan-footer">
                  <button
                    className="text-button"
                    onClick={() => {
                      setStart(week);
                      setEnd(addDays(week, 6));
                      navigate("shopping");
                    }}
                  >
                    Shop this week <ArrowRight size={16} />
                  </button>
                </div>
                {data.recipes.length > 0 && (
                  <section className="inspiration">
                    <div className="section-heading">
                      <div>
                        <h2>A few familiar favorites</h2>
                        <p>Good ideas for the days still open.</p>
                      </div>
                      <button className="text-button" onClick={() => navigate("recipes")}>
                        All saved recipes <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="recipe-tiles">
                      {data.recipes.slice(0, 4).map((recipe) => (
                        <button
                          key={recipe.id}
                          className="recipe-tile"
                          onClick={() => setModal({ kind: "recipe", recipe })}
                        >
                          <Photo recipe={recipe} />
                          <div>
                            <span className="category-label">{recipe.category}</span>
                            <h3>{recipe.title}</h3>
                            <p>
                              <Clock3 size={13} /> {recipe.minutes} min <span>·</span>
                              <Users size={13} /> {recipe.servings} servings
                            </p>
                          </div>
                          <span className="tile-arrow">
                            <ArrowRight size={16} />
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
            {page === "recipes" && (
              <>
                <div className="recipe-toolbar">
                  <label className="search-box">
                    <Search size={18} />
                    <input
                      aria-label="Search recipes"
                      placeholder="Find a recipe or ingredient…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <label>
                    <span className="muted small">Collection</span>
                    <select
                      aria-label="Filter by collection"
                      value={
                        selectedCollection
                          ? collectionFilter
                          : collectionFilter === "uncollected"
                            ? "uncollected"
                            : "all"
                      }
                      onChange={(event) => setCollectionFilter(event.target.value)}
                    >
                      <option value="all">All recipes</option>
                      <option value="uncollected">Uncollected</option>
                      {data.collections.map((collection) => (
                        <option key={collection.id} value={collection.id}>
                          {collection.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    onClick={() => {
                      setError("");
                      setModal({ kind: "collections" });
                    }}
                  >
                    <SlidersHorizontal size={16} /> Manage collections
                  </button>
                </div>
                <p className="muted small">
                  {matchingRecipes.length} {matchingRecipes.length === 1 ? "recipe" : "recipes"}
                </p>
                <div className="recipe-list">
                  {matchingRecipes.map((recipe) => (
                    <article className="recipe-row" key={recipe.id}>
                      <button
                        className="recipe-row-main"
                        onClick={() => setModal({ kind: "recipe", recipe })}
                      >
                        <Photo recipe={recipe} />
                        <div>
                          <span className="category-label">{recipe.category || "Uncollected"}</span>
                          <h2>{recipe.title}</h2>
                          <p>{recipe.description}</p>
                          <div className="row-meta">
                            <span>
                              <Clock3 size={14} />
                              {recipe.minutes} min
                            </span>
                            <span>
                              <Users size={14} />
                              {recipe.servings} servings
                            </span>
                            <span>{recipe.ingredients.length} ingredients</span>
                          </div>
                        </div>
                      </button>
                      <div className="recipe-row-actions">
                        <div className="recipe-rating" role="group" aria-label={`Rate ${recipe.title}`}>
                          {(["up", "neutral", "down"] as const).map((rating) => (
                            <button
                              key={rating}
                              type="button"
                              className={`rating-${rating}`}
                              aria-label={`${rating === "up" ? "Thumbs up" : rating === "down" ? "Thumbs down" : "Neutral"} for ${recipe.title}`}
                              aria-pressed={recipe.rating === rating}
                              disabled={busy}
                              onClick={() =>
                                mutate(`recipes/rating/${encodeURIComponent(recipe.id)}`, "PUT", { rating })
                              }
                            >
                              {rating === "up" ? (
                                <ThumbsUp size={16} />
                              ) : rating === "down" ? (
                                <ThumbsDown size={16} />
                              ) : (
                                <Minus size={16} />
                              )}
                            </button>
                          ))}
                        </div>
                        <button
                          className="secondary small-button"
                          onClick={() => addMeal(undefined, recipe.id)}
                        >
                          <Plus size={15} /> Add to plan
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {matchingRecipes.length === 0 && (
                  <div className="empty-state">
                    <BookOpen size={32} />
                    <h2>{search ? "No recipes found" : "Your collection starts here"}</h2>
                    <p>{search ? "Try another name or ingredient." : "Add a recipe you love to cook."}</p>
                  </div>
                )}
              </>
            )}
            {page === "shopping" && (
              <>
                <details className="date-disclosure shopping-range">
                  <summary>
                    <CalendarDays size={18} />
                    <span>
                      {start && end ? (
                        <>
                          {readableDate(start, { month: "short", day: "numeric" })}
                          {start.slice(0, 4) !== end.slice(0, 4) && `, ${start.slice(0, 4)}`}
                          {" – "}
                          {readableDate(end, { month: "short", day: "numeric", year: "numeric" })}
                        </>
                      ) : (
                        "Choose a date range"
                      )}
                    </span>
                    <span className="range-edit-label">Change dates</span>
                    <ChevronDown size={16} />
                  </summary>
                  <div className="range-toolbar">
                    <div className="date-range">
                      <CalendarDays size={18} />
                      <label>
                        From
                        <input
                          type="date"
                          aria-label="Shopping start date"
                          value={start}
                          max={end}
                          onChange={(event) => setStart(event.target.value)}
                        />
                      </label>
                      <span>—</span>
                      <label>
                        Through
                        <input
                          type="date"
                          aria-label="Shopping end date"
                          value={end}
                          min={start}
                          onChange={(event) => setEnd(event.target.value)}
                        />
                      </label>
                    </div>
                    <button
                      className="today-button"
                      onClick={() => {
                        setStart(weekStart());
                        setEnd(addDays(weekStart(), 6));
                      }}
                    >
                      This week
                    </button>
                    <span className="range-count">
                      {rangeMeals.length} planned meals <span>·</span> {items.length} shopping items
                    </span>
                  </div>
                </details>
                {start > end && <p className="error">The end date must come after the start date.</p>}
                <div className="shopping-summary">
                  <div role="status">
                    <strong>
                      {totalItems === 0
                        ? "Your list is ready to fill"
                        : totalCompleted === totalItems
                          ? "All done. Happy cooking!"
                          : `${totalItems - totalCompleted} items left to pick up`}
                    </strong>
                    <span>
                      {totalCompleted} of {totalItems} checked, including household extras
                    </span>
                  </div>
                  <div className="shopping-controls">
                    <button
                      className={shoppingMode ? "primary" : "secondary"}
                      aria-pressed={shoppingMode}
                      onClick={() => setShoppingMode(!shoppingMode)}
                    >
                      <ShoppingBasket size={16} />
                      {shoppingMode ? "Exit shopping mode" : "Shopping mode"}
                    </button>
                    <button
                      className={`secondary ${hideChecked ? "selected" : ""}`}
                      aria-pressed={hideChecked}
                      onClick={() => setHideChecked(!hideChecked)}
                    >
                      <SlidersHorizontal size={16} />{" "}
                      {hideChecked ? "Show checked items" : "Hide checked items"}
                    </button>
                  </div>
                </div>
                <div className="shopping-layout">
                  <section className="shopping-panel">
                    <div className="shopping-heading">
                      <div>
                        <h2>
                          For your meals <span className="count-pill">{items.length}</span>
                        </h2>
                        <p>
                          Whole packages for your combined recipes and meal scales. Warnings mark amounts to
                          review.
                        </p>
                      </div>
                    </div>
                    <div className="progress-row">
                      <div className="progress-track">
                        <div style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%` }} />
                      </div>
                      <span>
                        {completed} of {items.length} checked
                      </span>
                    </div>
                    <ShoppingItems
                      items={items}
                      groceries={data.groceries}
                      order={data.shoppingOrder}
                      busy={busy}
                      hideChecked={hideChecked}
                      checked={(item) => isChecked(checkKey(item, start, end))}
                      toggle={(item) => {
                        const key = checkKey(item, start, end);
                        void mutate("checks", "PUT", { key, checked: isChecked(key) ? 0 : 1 });
                      }}
                      saveOrder={(order) => mutate("shopping-order", "PUT", order, "Store route saved")}
                      edit={(item) => setModal({ kind: "grocery", item })}
                      manage={() => navigate("groceries")}
                    />
                    {hideChecked && items.length > 0 && completed === items.length && (
                      <div className="empty-state">
                        <Check size={28} />
                        <h2>Meal ingredients are all checked</h2>
                        <p>Use “Show checked items” to review what’s in your basket.</p>
                      </div>
                    )}
                    {items.length === 0 && (
                      <div className="empty-state">
                        <ShoppingBasket size={32} />
                        <h2>Nothing to shop for just yet</h2>
                        <p>Add a meal to this date range and its ingredients will appear here.</p>
                        <button className="text-button" onClick={() => navigate("plan")}>
                          Plan a meal <ArrowRight size={15} />
                        </button>
                      </div>
                    )}
                  </section>
                  <aside className="shopping-side">
                    <section className="extras-panel">
                      <span className="extras-icon">
                        <ShoppingBasket size={22} />
                      </span>
                      <h2>A little extra</h2>
                      <p>
                        Snacks, staples, and everything else.
                        <br />
                        Kept here across every date range.
                      </p>
                      <form
                        className="extra-form"
                        onSubmit={async (event) => {
                          event.preventDefault();

                          if (
                            await mutate("extras", "PUT", {
                              id: crypto.randomUUID(),
                              name: extra,
                              checked: 0,
                            })
                          )
                            setExtra("");
                        }}
                      >
                        <input
                          aria-label="New household item"
                          placeholder="e.g. coffee, apples, oat milk"
                          required
                          maxLength={200}
                          value={extra}
                          onChange={(event) => setExtra(event.target.value)}
                        />
                        <button
                          className="primary"
                          aria-label="Add household item"
                          disabled={busy || !extra.trim()}
                        >
                          <Plus size={18} />
                        </button>
                      </form>
                      <div className="extra-items">
                        {data.extras.map((item) =>
                          hideChecked && item.checked ? null : (
                            <div className={`extra-item ${item.checked ? "checked" : ""}`} key={item.id}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={!!item.checked}
                                  disabled={busy}
                                  onChange={() =>
                                    mutate("extras", "PUT", { ...item, checked: item.checked ? 0 : 1 })
                                  }
                                />
                                <span>{item.name}</span>
                              </label>
                              <button
                                className="icon-button"
                                aria-label={`Remove ${item.name}`}
                                disabled={busy}
                                onClick={() => mutate(`extras/${item.id}`, "DELETE", undefined)}
                              >
                                <X size={15} />
                              </button>
                            </div>
                          ),
                        )}
                      </div>
                      {hideChecked && data.extras.length > 0 && data.extras.every((item) => item.checked) && (
                        <p className="extras-complete">All household extras are checked.</p>
                      )}
                    </section>
                    <section className="notes-panel">
                      <Sprout size={25} strokeWidth={1.2} />
                      <h3>A note before you shop</h3>
                      <p>Check the pantry first. You might already have a few things on the list.</p>
                    </section>
                    {rangeMeals.some((meal) => meal.note) && (
                      <section className="meal-notes-panel">
                        <h3>Notes from your plan</h3>
                        <p>Reminders only — not added to ingredient totals. Add any extras above.</p>
                        {rangeMeals.map((meal) =>
                          meal.note ? (
                            <div key={meal.id}>
                              <small>
                                {readableDate(meal.date, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </small>
                              <p>{meal.note}</p>
                            </div>
                          ) : null,
                        )}
                      </section>
                    )}
                  </aside>
                </div>
              </>
            )}
            <footer className="page-footer">
              <span>
                <img src="/brand/logo-monochrome.svg" alt="Hearth" width="96" height="26" />
              </span>
              <p>A little less “what’s for dinner?”</p>
              <Leaf size={15} />
            </footer>
          </>
        )}
      </main>
      <KitchenTimers
        host={timerDialogHost ?? timerHeaderHost}
        recipeName={modal?.kind === "recipe" ? modal.recipe.title : ""}
        interactive={modal?.kind !== "meal"}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {modal?.kind === "grocery" && (
        <Dialog
          title="Grocery item"
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          <GroceryForm
            key={modal.item.id}
            item={modal.item}
            busy={busy}
            error={error}
            cancel={() => {
              setModal(null);
              setError("");
            }}
            save={(item) => mutate("groceries", "PUT", item, "Grocery item saved", true)}
            remove={
              data.groceries.some((item) => item.id === modal.item.id) &&
              !data.recipes.some((recipe) =>
                recipe.ingredients.some((ingredient) => ingredient.groceryItemId === modal.item.id),
              )
                ? () =>
                    mutate(
                      `groceries/${encodeURIComponent(modal.item.id)}`,
                      "DELETE",
                      undefined,
                      "Grocery item deleted",
                      true,
                    )
                : undefined
            }
          />
        </Dialog>
      )}
      {modal?.kind === "collections" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title="Manage collections"
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          <div className="modal-form">
            <p className="muted">
              Organize your recipes into collections. Deleting a collection keeps its recipes.
            </p>
            {data.collections.map((collection) => (
              <div className="section-heading collection-row" key={collection.id}>
                <div>
                  <strong>{collection.name}</strong>
                  <p className="muted small">
                    {data.recipes.filter((recipe) => recipe.category === collection.name).length}{" "}
                    {data.recipes.filter((recipe) => recipe.category === collection.name).length === 1
                      ? "recipe"
                      : "recipes"}
                  </p>
                </div>
                <button
                  className="secondary small-button"
                  aria-label={`Edit ${collection.name}`}
                  onClick={() => setModal({ kind: "collection", collection })}
                >
                  <Pencil size={16} /> Edit
                </button>
              </div>
            ))}
            {!data.collections.length && <p>No collections yet. Add one to get started.</p>}
            <button
              className="primary"
              onClick={() =>
                setModal({ kind: "collection", collection: { id: crypto.randomUUID(), name: "" } })
              }
            >
              <Plus size={16} /> Add collection
            </button>
          </div>
        </Dialog>
      )}
      {modal?.kind === "collection" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title={
            data.collections.some((collection) => collection.id === modal.collection.id)
              ? "Edit collection"
              : "Add collection"
          }
          close={() => {
            setModal({ kind: "collections" });
            setError("");
          }}
        >
          <CollectionForm
            collection={modal.collection}
            busy={busy}
            error={error}
            save={async (collection) => {
              if (await mutate("collections", "PUT", collection, "Collection saved"))
                setModal({ kind: "collections" });
            }}
            remove={
              data.collections.some((collection) => collection.id === modal.collection.id)
                ? async () => {
                    if (
                      await mutate(
                        `collections/${encodeURIComponent(modal.collection.id)}`,
                        "DELETE",
                        undefined,
                        "Collection deleted; recipes kept",
                      )
                    )
                      setModal({ kind: "collections" });
                  }
                : undefined
            }
          />
        </Dialog>
      )}
      {modal?.kind === "meal" && (
        <Dialog
          title={data.meals.some((meal) => meal.id === modal.meal.id) ? "Edit meal" : "Add a meal"}
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          <MealForm
            meal={modal.meal}
            recipes={data.recipes}
            busy={busy}
            error={error}
            save={(meal) => mutate("meals", "PUT", meal, "Meal plan updated", true)}
            remove={
              data.meals.some((meal) => meal.id === modal.meal.id)
                ? () => mutate(`meals/${modal.meal.id}`, "DELETE", undefined, "Meal removed", true)
                : undefined
            }
            viewRecipe={(recipe, meal) => setModal({ kind: "recipe", recipe, meal })}
          />
        </Dialog>
      )}
      {modal?.kind === "recipe" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title="Recipe details"
          close={() => {
            setModal(modal.meal ? { kind: "meal", meal: modal.meal } : null);
            setError("");
          }}
          fullScreen
        >
          <RecipeDetail
            recipe={modal.recipe}
            groceries={data.groceries}
            edit={modal.meal ? undefined : () => setModal({ kind: "editor", recipe: modal.recipe })}
            plan={() =>
              modal.meal ? setModal({ kind: "meal", meal: modal.meal }) : addMeal(undefined, modal.recipe.id)
            }
            meal={modal.meal}
          />
        </Dialog>
      )}
      {modal?.kind === "import" && (
        <Dialog timerHost={setTimerDialogHost} title="Import a recipe" close={() => setModal(null)}>
          <RecipeImport imported={(recipe, warnings) => setModal({ kind: "editor", recipe, warnings })} />
        </Dialog>
      )}
      {modal?.kind === "editor" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title={
            data.recipes.some((recipe) => recipe.id === modal.recipe.id) ? "Edit recipe" : "Add a recipe"
          }
          close={() => {
            setModal(null);
            setError("");
          }}
          wide
        >
          <RecipeForm
            recipe={modal.recipe}
            collections={data.collections}
            groceries={data.groceries}
            saveGrocery={(item) => mutate("groceries", "PUT", item, "Grocery item saved")}
            warnings={modal.warnings}
            busy={busy}
            error={error}
            save={(recipe) => mutate("recipes", "PUT", recipe, "Recipe saved to your collection", true)}
            remove={
              data.recipes.some((recipe) => recipe.id === modal.recipe.id)
                ? () => mutate(`recipes/${modal.recipe.id}`, "DELETE", undefined, "Recipe deleted", true)
                : undefined
            }
          />
        </Dialog>
      )}
    </div>
  );
}

function CollectionForm({
  collection,
  busy,
  error,
  save,
  remove,
}: {
  collection: Collection;
  busy: boolean;
  error: string;
  save: (collection: Collection) => Promise<void>;
  remove?: () => Promise<void>;
}) {
  const [name, setName] = useState(collection.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        save({ ...collection, name });
      }}
    >
      <label>
        Collection name
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirmDelete ? (
        <div className="delete-confirm">
          <p>
            Delete “{collection.name}”? Its recipes will stay saved as Uncollected. This cannot be undone.
          </p>
          <button type="button" className="danger" disabled={busy} onClick={remove}>
            Delete collection
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="form-actions">
          {remove && (
            <button type="button" className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} /> Delete collection
            </button>
          )}
          <button className="primary" disabled={busy || !name.trim()}>
            Save collection
          </button>
        </div>
      )}
    </form>
  );
}

function MealForm({
  meal,
  recipes,
  busy,
  error,
  save,
  remove,
  viewRecipe,
}: {
  meal: Meal;
  recipes: readonly Recipe[];
  busy: boolean;
  error: string;
  save: (meal: Meal) => Promise<boolean>;
  remove?: () => Promise<boolean>;
  viewRecipe: (recipe: Recipe, meal: Meal) => void;
}) {
  const [draft, setDraft] = useState(meal);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [debouncedRecipeSearch, setDebouncedRecipeSearch] = useState("");
  const recipeSearchInput = useRef<HTMLInputElement>(null);
  const recipe = recipes.find((entry) => entry.id === draft.recipeId);
  const searching = recipeSearch.trim() !== debouncedRecipeSearch;

  const recipeResults = useMemo(
    () => recipes.filter((entry) => matchesRecipeSearch(entry, debouncedRecipeSearch)),
    [recipes, debouncedRecipeSearch],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedRecipeSearch(recipeSearch.trim()), 300);

    return () => window.clearTimeout(timeout);
  }, [recipeSearch]);

  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (recipe) save(draft);
      }}
    >
      <label>
        Recipe
        <input
          ref={recipeSearchInput}
          type="search"
          placeholder="Search recipes by name or ingredient…"
          autoComplete="off"
          value={recipeSearch}
          onChange={(event) => setRecipeSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          aria-describedby={recipeSearch.trim() ? "meal-recipe-search-status" : undefined}
        />
      </label>
      {recipeSearch.trim() && (
        <div className="meal-recipe-results" aria-busy={searching}>
          <p id="meal-recipe-search-status" role="status">
            {searching
              ? "Searching…"
              : recipeResults.length
                ? `${recipeResults.length} matching ${recipeResults.length === 1 ? "recipe" : "recipes"}`
                : "No recipes found. Try another name or ingredient."}
          </p>
          {!searching && recipeResults.length > 0 && (
            <ul aria-label="Matching recipes">
              {recipeResults.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft({ ...draft, recipeId: entry.id });
                      setRecipeSearch("");
                      setDebouncedRecipeSearch("");
                      recipeSearchInput.current?.focus();
                    }}
                  >
                    <span>{entry.title}</span>
                    <small>
                      {entry.minutes} min · {entry.servings} servings
                    </small>
                    {entry.id === draft.recipeId && <Check size={16} aria-label="Selected recipe" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {recipe && (
        <button
          type="button"
          className="selected-recipe"
          onClick={(event) => {
            if (event.currentTarget.form?.reportValidity()) viewRecipe(recipe, draft);
          }}
        >
          <Photo recipe={recipe} />
          <span>
            <strong>{recipe.title}</strong>
            <small>
              {recipe.minutes} minutes · View recipe <ArrowRight size={12} />
            </small>
          </span>
        </button>
      )}
      <div className="form-grid">
        <label>
          Date
          <input
            type="date"
            value={draft.date}
            required
            onChange={(event) => setDraft({ ...draft, date: event.target.value })}
          />
        </label>
        <label>
          Meal
          <select
            value={draft.slot}
            onChange={(event) => {
              const slot = event.target.value;

              if (slot === "Breakfast" || slot === "Lunch" || slot === "Dinner") setDraft({ ...draft, slot });
            }}
          >
            <option>Breakfast</option>
            <option>Lunch</option>
            <option>Dinner</option>
          </select>
        </label>
      </div>
      <div className="scale-panel">
        <div>
          <label htmlFor="meal-scale">Recipe scale</label>
          <p>
            {recipe
              ? `${quantity(recipe.servings * draft.scale)} servings · original recipe serves ${recipe.servings}`
              : "Choose a recipe"}
          </p>
        </div>
        <div className="scale-input">
          <select
            id="meal-scale"
            aria-label="Recipe scale"
            required
            value={draft.scale}
            onChange={(event) => setDraft({ ...draft, scale: Number(event.target.value) })}
          >
            {[...new Set([meal.scale, ...Array.from({ length: 400 }, (_, index) => (index + 1) / 4)])]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
          </select>
        </div>
      </div>
      <label>
        A note for this meal <span className="muted">(optional)</span>
        <textarea
          placeholder="Add chicken, save some for lunch, dinner with friends…"
          maxLength={2000}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {remove && (
          <button type="button" className="danger text-button" disabled={busy} onClick={remove}>
            <Trash2 size={16} /> Remove meal
          </button>
        )}
        <button className="primary" disabled={busy || !recipe}>
          {busy ? "Saving…" : "Save to meal plan"}
          <Check size={16} />
        </button>
      </div>
    </form>
  );
}

function RecipeDetail({
  recipe,
  groceries,
  edit,
  plan,
  meal,
}: {
  recipe: Recipe;
  groceries: readonly GroceryItem[];
  edit?: () => void;
  plan: () => void;
  meal?: Meal;
}) {
  const [scale, setScale] = useState(meal?.scale ?? 1);

  return (
    <div className="recipe-detail" tabIndex={0} role="region" aria-label={`${recipe.title} recipe`}>
      <Photo recipe={recipe} className="detail-hero" />
      <div className="detail-title">
        <span className="category-label">{recipe.category}</span>
        <h1>{recipe.title}</h1>
        <p>{recipe.description}</p>
        <div className="detail-meta">
          <span>
            <Clock3 size={16} />
            {recipe.minutes} min
          </span>
          <span>
            <Users size={16} />
            {quantity(recipe.servings * scale)} servings
          </span>
          {edit && (
            <button className="text-button" onClick={edit}>
              <Pencil size={14} /> Edit recipe
            </button>
          )}
        </div>
      </div>
      <div className="detail-columns">
        <section>
          <div className="ingredients-heading">
            <h2>Ingredients</h2>
            <select
              aria-label="Preview recipe scale"
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            >
              {[...new Set([0.5, 1, 1.5, 2, 3, scale])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
            </select>
          </div>
          <ul className="ingredient-list">
            {recipe.ingredients.map((item, index) => {
              const grocery = groceries.find((entry) => entry.id === item.groceryItemId);

              return (
                <li key={index}>
                  <span>
                    {item.name}
                    {grocery ? (
                      grocery.url ? (
                        <a
                          className="ingredient-product-link"
                          href={grocery.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {grocery.name} ↗ · {displayAmount(grocery)} per package
                        </a>
                      ) : (
                        <span className="ingredient-product-link">
                          {grocery.name} · {displayAmount(grocery)} per package
                        </span>
                      )
                    ) : (
                      <span className="ingredient-product-link unlinked">No grocery item linked</span>
                    )}
                  </span>
                  <strong>{displayAmount({ ...item, quantity: item.quantity * scale })}</strong>
                </li>
              );
            })}
          </ul>
          {edit && (
            <button className="text-button" onClick={edit}>
              <Package size={15} /> Manage ingredient links
            </button>
          )}
        </section>
        <section>
          <h2>Let’s make it</h2>
          <ol className="instructions">
            {recipe.instructions.map((step, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
          <p className="field-hint">
            Instruction text is kept as written; use the scaled ingredient amounts.
          </p>
        </section>
      </div>
      <div className="detail-footer">
        {recipe.source ? (
          <a href={recipe.source} target="_blank" rel="noreferrer">
            Recipe source <ExternalLink size={28} />
          </a>
        ) : (
          <span>From our kitchen</span>
        )}
        <button className="primary" onClick={plan}>
          {meal ? <ChevronLeft size={16} /> : <Plus size={16} />} {meal ? "Back to meal" : "Add to meal plan"}
        </button>
      </div>
    </div>
  );
}

function RecipeImport({ imported }: { imported: (recipe: Recipe, warnings: readonly string[]) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);

  useEffect(() => {
    active.current = true;

    return () => {
      active.current = false;
    };
  }, []);

  const submit = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await api("recipes/import", "POST", { url });

      const result = Schema.decodeUnknownSync(
        Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }),
      )(await response.json());

      if (active.current) imported(result.recipe, result.warnings);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "Please try again.");
    } finally {
      if (active.current) setLoading(false);
    }
  };

  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p>Paste a NYT Cooking recipe link. We’ll fill in the recipe for you to review and save.</p>
      <label>
        Recipe URL
        <input
          type="url"
          required
          autoFocus
          maxLength={4000}
          placeholder="https://cooking.nytimes.com/recipes/…"
          value={url}
          disabled={loading}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p className="field-hint">
        Unlocked share links are supported. Your original link is kept with the recipe.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={loading || !url.trim()}>
        {loading ? "Importing…" : "Import and review"}
        <ArrowRight size={16} />
      </button>
      {loading && <p role="status">Reading the recipe. This can take up to 20 seconds.</p>}
    </form>
  );
}

function RecipeForm({
  recipe,
  collections,
  groceries,
  saveGrocery,
  warnings,
  busy,
  error,
  save,
  remove,
}: {
  recipe: Recipe;
  collections: readonly Collection[];
  groceries: readonly GroceryItem[];
  saveGrocery: (item: GroceryItem) => Promise<boolean>;
  warnings?: readonly string[];
  busy: boolean;
  error: string;
  save: (recipe: Recipe) => Promise<boolean>;
  remove?: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({
    ...recipe,
    category: collections.some((collection) => collection.name === recipe.category) ? recipe.category : "",
  });

  const [photoError, setPhotoError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [groceryEditor, setGroceryEditor] = useState<{ item: GroceryItem; index: number } | null>(null);

  const updateIngredient = (index: number, ingredient: Ingredient) =>
    setDraft({
      ...draft,
      ingredients: draft.ingredients.map((item, position) => (position === index ? ingredient : item)),
    });

  const upload = async (file?: File) => {
    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 1_200_000) {
      setPhotoError("Choose a JPG, PNG, or WebP photo smaller than 1.2 MB.");

      return;
    }

    setPhotoError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result && !(reader.result instanceof ArrayBuffer))
        setDraft((current) => ({ ...current, photo: reader.result?.toString() ?? "" }));
    };

    reader.onerror = () => setPhotoError("That photo couldn’t be read. Please try another.");
    reader.readAsDataURL(file);
  };

  return (
    <>
      <form
        className="modal-form recipe-form"
        onSubmit={(event) => {
          event.preventDefault();
          save(draft);
        }}
      >
        {warnings && (
          <div className="field-hint" role="status">
            Review the imported recipe, quantities, and collection before saving. Timing follows the source;
            marinating or resting may be additional.
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
        <label>
          Recipe name
          <input
            required
            maxLength={150}
            placeholder="Grandma’s Sunday pasta"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          A few words about it
          <textarea
            maxLength={2000}
            placeholder="What makes this one a keeper?"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <div className="form-grid three">
          <label>
            Servings
            <input
              type="number"
              min="0.5"
              max="100"
              step="0.5"
              required
              value={draft.servings}
              onChange={(event) => setDraft({ ...draft, servings: event.target.valueAsNumber })}
            />
          </label>
          <label>
            Time (minutes)
            <input
              type="number"
              min="1"
              max="10000"
              required
              value={draft.minutes}
              onChange={(event) => setDraft({ ...draft, minutes: event.target.valueAsNumber })}
            />
          </label>
          <label>
            Collection
            <select
              value={draft.category}
              onChange={(event) => setDraft({ ...draft, category: event.target.value })}
            >
              <option value="">Uncollected</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.name}>
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Source URL <span className="muted">(optional)</span>
          <input
            type="url"
            placeholder="https://…"
            value={draft.source}
            onChange={(event) => setDraft({ ...draft, source: event.target.value })}
          />
        </label>
        <div className="photo-fields">
          <label>
            Photo URL <span className="muted">(or upload below)</span>
            <input
              placeholder="https://…"
              value={draft.photo.startsWith("data:") ? "Uploaded photo" : draft.photo}
              readOnly={draft.photo.startsWith("data:")}
              onChange={(event) => setDraft({ ...draft, photo: event.target.value })}
            />
          </label>
          <label className="file-label">
            Upload a photo
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => upload(event.target.files?.[0])}
            />
          </label>
          {draft.photo && (
            <button type="button" className="text-button" onClick={() => setDraft({ ...draft, photo: "" })}>
              Remove photo
            </button>
          )}
          {photoError && <p className="error">{photoError}</p>}
        </div>
        <div className="editor-section">
          <h2>Ingredients</h2>
          <p className="field-hint">
            Link each ingredient to the product you buy. Automatic matching uses exact product or alternate
            names. Recipe quantities stay unchanged.
          </p>
          {draft.ingredients.map((item, index) => {
            const automatic =
              item.groceryItemId === undefined ? matchGrocery(item.name, groceries) : undefined;

            const linked = groceries.find((entry) => entry.id === (item.groceryItemId ?? automatic?.id));

            return (
              <div className="ingredient-editor" key={index}>
                <input
                  aria-label={`Ingredient ${index + 1} name`}
                  placeholder="Ingredient"
                  maxLength={150}
                  required
                  value={item.name}
                  onChange={(event) => updateIngredient(index, { ...item, name: event.target.value })}
                />
                <input
                  aria-label={`Ingredient ${index + 1} quantity`}
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="any"
                  required
                  value={item.quantity}
                  onChange={(event) =>
                    updateIngredient(index, { ...item, quantity: event.target.valueAsNumber })
                  }
                />
                <select
                  aria-label={`Ingredient ${index + 1} unit`}
                  value={item.unit}
                  onChange={(event) => updateIngredient(index, { ...item, unit: event.target.value })}
                >
                  {units.map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ingredient ${index + 1}`}
                  disabled={draft.ingredients.length === 1}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      ingredients: draft.ingredients.filter((_, position) => position !== index),
                    })
                  }
                >
                  <X size={16} />
                </button>
                <div className="ingredient-link-editor">
                  <select
                    aria-label={`Grocery item for ingredient ${index + 1}`}
                    value={item.groceryItemId === undefined ? "auto" : (item.groceryItemId ?? "unlinked")}
                    onChange={(event) =>
                      updateIngredient(index, {
                        ...item,
                        groceryItemId:
                          event.target.value === "auto"
                            ? undefined
                            : event.target.value === "unlinked"
                              ? null
                              : event.target.value,
                      })
                    }
                  >
                    <option value="auto">
                      {automatic ? `Auto-match: ${automatic.name}` : "Auto-match on save · no match yet"}
                    </option>
                    <option value="unlinked">Leave unlinked (manual review)</option>
                    {groceries.map((grocery) => (
                      <option key={grocery.id} value={grocery.id}>
                        {grocery.name} · {displayAmount(grocery)}
                      </option>
                    ))}
                  </select>
                  {linked && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => setGroceryEditor({ item: linked, index })}
                    >
                      <Pencil size={13} /> Edit product
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || !item.name.trim()}
                    onClick={() => setGroceryEditor({ item: newGrocery(item.name, item.unit), index })}
                  >
                    <Plus size={13} /> New product
                  </button>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setDraft({
                ...draft,
                ingredients: [...draft.ingredients, { name: "", quantity: 1, unit: "each" }],
              })
            }
          >
            <Plus size={15} /> Add ingredient
          </button>
        </div>
        <div className="editor-section">
          <h2>Cooking instructions</h2>
          {draft.instructions.map((step, index) => (
            <div className="instruction-editor" key={index}>
              <span>{index + 1}</span>
              <textarea
                required
                aria-label={`Step ${index + 1}`}
                maxLength={10000}
                placeholder="What happens next?"
                value={step}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    instructions: draft.instructions.map((value, position) =>
                      position === index ? event.target.value : value,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove step ${index + 1}`}
                disabled={draft.instructions.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    instructions: draft.instructions.filter((_, position) => position !== index),
                  })
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() => setDraft({ ...draft, instructions: [...draft.instructions, ""] })}
          >
            <Plus size={15} /> Add step
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {confirmDelete && (
          <div className="delete-confirm">
            <p>Delete this recipe permanently? Planned recipes must be removed from the calendar first.</p>
            <button type="button" className="danger text-button" disabled={busy} onClick={remove}>
              Yes, delete recipe
            </button>
            <button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>
              Keep recipe
            </button>
          </div>
        )}
        <div className="form-actions">
          {remove && (
            <button
              type="button"
              className="danger text-button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} /> Delete recipe
            </button>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save recipe"}
            <Check size={16} />
          </button>
        </div>
      </form>
      {groceryEditor && (
        <Dialog title="Grocery item for ingredient" close={() => setGroceryEditor(null)}>
          <GroceryForm
            key={groceryEditor.item.id}
            item={groceryEditor.item}
            busy={busy}
            error={error}
            cancel={() => setGroceryEditor(null)}
            save={async (item) => {
              if (!(await saveGrocery(item))) return false;
              setDraft((current) => ({
                ...current,
                ingredients: current.ingredients.map((ingredient, index) =>
                  index === groceryEditor.index ? { ...ingredient, groceryItemId: item.id } : ingredient,
                ),
              }));
              setGroceryEditor(null);

              return true;
            }}
          />
        </Dialog>
      )}
    </>
  );
}
