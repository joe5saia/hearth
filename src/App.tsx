import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Option, Schema } from "effect";
import { KitchenTimers } from "./KitchenTimers";
import { GroceryForm, GroceryManager } from "./GroceryManager";
import { ShoppingItems } from "./ShoppingItems";
import { ShoppingRecipeForm } from "./ShoppingRecipeForm";
import { RecipeChecklist } from "./RecipeChecklist";
import { MealCard } from "./MealCard";
import { ChatGPTSetup } from "./ChatGPTSetup";
import { readRoute, recipeSorts, routeHash, type Page, type Route } from "./navigation";
import { ShareLink } from "./ShareLink";
import { FeedbackForm } from "./FeedbackForm";
import { feedbackURL, type FeedbackInput } from "./feedback-contract";
import { browserEvent, browserOperation, browserResponse } from "./browser-observability";
import { matchGrocery } from "./groceries";
import { GrocerySearch } from "./ingredient-matching";
import { MatchReportSchema } from "./domain";
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
  ListChecks,
  Plus,
  Search,
  ShoppingBasket,
  SlidersHorizontal,
  Sprout,
  Trash2,
  ThumbsDown,
  ThumbsUp,
  Minus,
  MoreHorizontal,
  Users,
  X,
  ExternalLink,
  Pencil,
  Package,
  MessageCircle,
  ArrowUpDown,
} from "lucide-react";
import {
  addDays,
  checkKey,
  dateKey,
  displayAmount,
  quantity,
  shoppingList,
  units,
  weekStart,
  nextDinnerDate,
  validDate,
  matchesRecipeSearch,
  RecipeSchema,
  HouseholdSchema,
  DateSchema,
  UnitSchema,
  type CheckWriteSchema,
  type Household,
  type Collection,
  type IngredientDraft,
  type MealDraft,
  type RecipeDraft,
  type GroceryDraft,
  type GroceryId,
  type Unit,
  type Recipe,
  type Rating,
  type GroceryItem,
  type ShoppingOrder,
} from "./domain";

const mobileViewport = "(max-width: 850px), (pointer: coarse) and (max-height: 500px)";

type ShoppingEdit =
  | { kind: "order"; order: ShoppingOrder }
  | ({ kind: "check" } & typeof CheckWriteSchema.Type);

function applyShoppingEdit(state: Pick<Household, "shoppingOrder" | "checks">, edit: ShoppingEdit) {
  if (edit.kind === "check" && edit.onlyIfAbsent && state.checks.some((entry) => entry.key === edit.key))
    return state;

  return edit.kind === "order"
    ? { checks: state.checks, shoppingOrder: edit.order }
    : {
        shoppingOrder: state.shoppingOrder,
        checks: [
          ...state.checks.filter((entry) => entry.key !== edit.key),
          ...(!edit.checked
            ? [
                {
                  key: edit.key,
                  checked: edit.checked,
                  packages:
                    edit.packages ?? state.checks.find((entry) => entry.key === edit.key)?.packages ?? 1,
                },
              ]
            : []),
        ],
      };
}

type Modal =
  | { kind: "collections" }
  | { kind: "shopping-recipes" }
  | { kind: "chatgpt" }
  | { kind: "feedback"; context: FeedbackInput["context"] }
  | { kind: "grocery"; item: GroceryDraft }
  | { kind: "collection"; collection: Collection }
  | { kind: "meal"; meal: MealDraft }
  | { kind: "recipe"; recipe: Recipe; meal?: MealDraft; returnToMeal?: boolean }
  | { kind: "import" }
  | { kind: "editor"; recipe: RecipeDraft; isNew?: boolean; warnings?: readonly string[] };

const emptyHousehold: Household = {
  collections: [],
  recipes: [],
  recipesAdded: [],
  meals: [],
  extras: [],
  checks: [],
  groceries: [],
  shoppingOrder: { aisles: [], items: [] },
};

const newGrocery = (name = "", unit: Unit = "each"): GroceryDraft => ({
  id: crypto.randomUUID(),
  name,
  unit,
  quantity: 1,
  url: "",
  aisle: "",
  aliases: name ? [name] : [],
});

const readableDate = (
  date: MealDraft["date"],
  options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" },
) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", options);

// Only deliberately translated HTTP failures may contribute public exception text.
class ApiError extends Error {}

async function api(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?:
    | RecipeDraft
    | (RecipeDraft & { expectedIngredients: RecipeDraft["ingredients"] | null })
    | Collection
    | MealDraft
    | GroceryDraft
    | ShoppingOrder
    | { url: string }
    | Household["extras"][number]
    | typeof CheckWriteSchema.Type
    | { from: string; to: string }
    | { rating: Rating },
  operationId = crypto.randomUUID(),
) {
  const started = performance.now();

  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "X-Hearth-Operation-Id": operationId },
  };

  if (body && method !== "GET") init.body = JSON.stringify(body);

  let response: Response;

  try {
    response = await fetch(`/api/${path}`, init);
  } catch (failure) {
    browserEvent("browser_request", {
      operation: browserOperation(path),
      method,
      outcome: "network_error",
      durationMs: performance.now() - started,
      relatedOperationId: operationId,
    });
    throw failure;
  }

  browserEvent("browser_request", {
    operation: browserOperation(path),
    method,
    status: response.status,
    outcome: response.ok ? "success" : "error",
    durationMs: performance.now() - started,
    ...browserResponse(response, operationId),
  });

  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(
      await response.json().catch(() => null),
    );

    throw new ApiError(
      Option.isSome(failure)
        ? failure.value.error
        : method === "GET"
          ? "Household data couldn’t be loaded. Refresh to try loading it again."
          : "The household request couldn’t be confirmed. Refresh to check the current state before making the change again.",
      { cause: response.status },
    );
  }

  return response;
}

function Photo({ recipe, className = "" }: { recipe: Pick<Recipe, "photo" | "title">; className?: string }) {
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
  shareable = true,
  timerHost,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  fullScreen?: boolean;
  shareable?: boolean;
  timerHost?: (element: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();

    // Close while still connected so the browser can restore the invoker's focus.
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (!fullScreen) return;

    // A nested fullscreen dialog shares its ancestor's lock, including when both unmount together.
    if (ref.current?.parentElement?.closest("dialog.fullscreen")) return;

    const scrollY = window.scrollY;
    const bodyStyle = document.body.style.cssText;

    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.cssText = bodyStyle;
      window.scrollTo({ top: scrollY, behavior: "instant" });
    };
  }, [fullScreen]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal${wide ? " wide" : ""}${fullScreen ? " fullscreen" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onClick={(event) => {
        if (!fullScreen && event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2 tabIndex={fullScreen ? -1 : undefined} autoFocus={fullScreen}>
          {title}
        </h2>
        {timerHost && <div className="timer-slot" ref={timerHost} />}
        {shareable && <ShareLink compact />}
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

/** Owns household browser state, queued shopping writes, API synchronization, and hash navigation. */
export function App() {
  const [route, setRoute] = useState(readRoute);
  const routeRef = useRef(route);
  const entries = useRef(new Map<string, Route>());
  const lastHistoryEvent = useRef("");
  const { page, week, search, collection: collectionFilter, sort: recipeSort } = route;
  const shoppingMode = route.mode === "focus";
  const listBuilder = route.mode === "builder";
  const arranging = route.mode === "arrange";
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia(mobileViewport).matches);
  const [data, setData] = useState<Household>(emptyHousehold);

  const aisles = useMemo(
    () =>
      [...new Set(data.groceries.map((item) => item.aisle.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    [data.groceries],
  );

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModalState] = useState<Modal | null>(null);
  // Only transient nested meal previews keep a draft, in memory, never in URLs/history storage.
  const mealDrafts = useRef(new Map<string, MealDraft>());
  const routeLoaded = useRef(false);
  const [extra, setExtra] = useState("");
  const [extraAisle, setExtraAisle] = useState("");
  // Possible existing catalog items for the typed name; null until the add form is submitted.
  const [extraMatches, setExtraMatches] = useState<readonly GroceryItem[] | null>(null);
  const extraInput = useRef<HTMLInputElement>(null);
  const builderSearch = search;
  const [debouncedBuilderSearch, setDebouncedBuilderSearch] = useState("");
  const [shoppingPending, setShoppingPending] = useState(0);
  const shoppingEdits = useRef<ShoppingEdit[]>([]);
  const shoppingWrites = useRef<Promise<boolean | void>>(Promise.resolve());
  const shoppingRevision = useRef(0);
  const confirmedShopping = useRef<Pick<Household, "shoppingOrder" | "checks">>(emptyHousehold);
  const [timerHeaderHost, setTimerHeaderHost] = useState<HTMLDivElement | null>(null);
  const [timerDialogHost, setTimerDialogHost] = useState<HTMLDivElement | null>(null);
  const weekInput = useRef<HTMLInputElement>(null);
  const weekPicker = useRef<HTMLElement>(null);
  const pageOptions = useRef<HTMLElement>(null);
  const initialLoad = useRef(true);

  const updateRoute = (patch: Partial<Route>, replace = false) => {
    lastHistoryEvent.current = "";
    const next = { ...routeRef.current, ...patch };
    const hash = routeHash(next);

    if (hash !== routeHash(routeRef.current)) {
      const state = {
        hearth: {
          key: crypto.randomUUID(),
          parent: history.state?.hearth?.key,
          parentHash: routeHash(routeRef.current),
        },
      };

      if (replace) history.replaceState(history.state, "", hash);
      else history.pushState(state, "", hash);
    }

    if (history.state?.hearth?.key) entries.current.set(history.state.hearth.key, next);
    routeRef.current = next;
    setRoute(next);
  };

  const baseView = {
    view: undefined,
    id: undefined,
    meal: undefined,
    recipe: undefined,
    date: undefined,
    scale: undefined,
  };

  const setWeek = (week: string) => updateRoute({ week });
  const setSearch = (search: string) => updateRoute({ search }, true);
  const setCollectionFilter = (collection: string) => updateRoute({ collection });

  const setRecipeSort = (sort: string) =>
    updateRoute({ sort: recipeSorts.find((candidate) => candidate === sort) ?? "az" });

  const setModal = (next: Modal | null) => {
    // Feedback is transient, not a shareable view. Do not rewrite its originating URL.
    if (next?.kind === "feedback" || (!next && modal?.kind === "feedback")) {
      setModalState(next);

      return;
    }

    if (!next) {
      // Only go Back to a known Hearth parent, including the safe page behind a direct link.
      if (routeRef.current.view && entries.current.has(history.state?.hearth?.parent)) history.back();
      else updateRoute(baseView, true);
      setModalState(null);

      return;
    }

    const parent = entries.current.get(history.state?.hearth?.parent);

    if (parent?.view === next.kind && (next.kind === "meal" || next.kind === "collections")) {
      history.back();
      setModalState(next);

      return;
    }

    const patch: Partial<Route> = { ...baseView, view: next.kind };

    switch (next.kind) {
      case "recipe":
        patch.id = next.recipe.id;

        if (next.meal && data.meals.some((meal) => meal.id === next.meal?.id)) patch.meal = next.meal.id;

        if (next.returnToMeal && next.meal && history.state?.hearth?.key)
          mealDrafts.current.set(history.state.hearth.key, next.meal);
        break;
      case "editor":
        if (!next.isNew) patch.id = next.recipe.id;
        break;
      case "meal":
        if (data.meals.some((meal) => meal.id === next.meal.id)) patch.id = next.meal.id;
        else {
          patch.date = next.meal.date;

          if (next.meal.recipeId) patch.recipe = next.meal.recipeId;
        }

        break;
      case "grocery":
        if (data.groceries.some((item) => item.id === next.item.id)) patch.id = next.item.id;
        break;
      case "collection":
        if (data.collections.some((collection) => collection.id === next.collection.id))
          patch.id = next.collection.id;
        break;
    }

    updateRoute(patch);
    setModalState(next);
  };

  const resolveModal = useCallback(
    (next: Route): Modal | null => {
      const missing = () => {
        setError("This item is no longer available. It may have been deleted from your household.");

        return null;
      };

      const recipe = data.recipes.find((recipe) => recipe.id === next.id);

      switch (next.view) {
        case "recipe": {
          const draft = mealDrafts.current.get(history.state?.hearth?.parent);

          if (recipe && draft) return { kind: "recipe", recipe, meal: draft, returnToMeal: true };
          const meal = next.meal ? data.meals.find((meal) => meal.id === next.meal) : undefined;

          if (!recipe || (next.meal && !meal)) return missing();

          return { kind: "recipe", recipe, meal };
        }

        case "editor":
          if (next.id) return recipe ? { kind: "editor", recipe } : missing();

          return {
            kind: "editor",
            isNew: true,
            recipe: {
              id: crypto.randomUUID(),
              title: "",
              description: "",
              servings: 4,
              minutes: 30,
              category: data.collections.find((collection) => collection.id === next.collection)?.name ?? "",
              photo: "",
              source: "",
              rating: "neutral",
              ingredients: [{ name: "", quantity: 1, unit: "each" }],
              instructions: [""],
            },
          };
        case "meal": {
          const draft = mealDrafts.current.get(history.state?.hearth?.key);
          const meal = next.id ? data.meals.find((meal) => meal.id === next.id) : undefined;

          if (
            (next.id && !meal) ||
            (next.recipe && !data.recipes.some((recipe) => recipe.id === next.recipe))
          )
            return missing();

          return {
            kind: "meal",
            meal: draft ??
              meal ?? {
                id: crypto.randomUUID(),
                recipeId: next.recipe ?? data.recipes[0]?.id ?? null,
                date: next.date ?? nextDinnerDate(data.meals, next.week),
                slot: "Dinner",
                scale: 1,
                note: "",
              },
          };
        }

        case "grocery": {
          const item = data.groceries.find((item) => item.id === next.id);

          return next.id
            ? item
              ? { kind: "grocery", item }
              : missing()
            : { kind: "grocery", item: newGrocery() };
        }

        case "collection": {
          const collection = data.collections.find((collection) => collection.id === next.id);

          return next.id
            ? collection
              ? { kind: "collection", collection }
              : missing()
            : { kind: "collection", collection: { id: crypto.randomUUID(), name: "" } };
        }

        case "collections":
        case "import":
        case "chatgpt":
        case "shopping-recipes":
          return { kind: next.view };
        default:
          return null;
      }
    },
    [data],
  );

  const refresh = useCallback(async (operationId = crypto.randomUUID()) => {
    const started = performance.now();
    const revision = shoppingRevision.current;
    const response = await api("household", "GET", undefined, operationId);
    const body = await response.text();
    const downloaded = performance.now();
    let household: Household;

    try {
      household = Schema.decodeUnknownSync(HouseholdSchema)(JSON.parse(body));
    } catch (failure) {
      browserEvent("browser_household", {
        outcome: "error",
        reason: "decode_error",
        durationMs: performance.now() - started,
        ...browserResponse(response, operationId),
      });
      throw failure;
    }

    const decoded = performance.now();
    const initial = initialLoad.current;
    initialLoad.current = false;

    // A refresh started before a shopping edit must not replace newer acknowledged/optimistic state.
    if (revision === shoppingRevision.current) {
      confirmedShopping.current = { checks: household.checks, shoppingOrder: household.shoppingOrder };
    }

    setData({ ...household, ...shoppingEdits.current.reduce(applyShoppingEdit, confirmedShopping.current) });
    setLoaded(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        browserEvent("browser_household", {
          outcome: "success",
          initial,
          durationMs: initial ? performance.now() : performance.now() - started,
          downloadMs: downloaded - started,
          decodeMs: decoded - downloaded,
          bytes: new TextEncoder().encode(body).byteLength,
          recipes: household.recipes.length,
          meals: household.meals.length,
          groceries: household.groceries.length,
          ...browserResponse(response, operationId),
        }),
      ),
    );
  }, []);

  const saveShoppingEdit = (edit: ShoppingEdit) => {
    const started = performance.now();
    const operationId = crypto.randomUUID();
    const queueDepth = shoppingEdits.current.length + 1;
    shoppingEdits.current.push(edit);
    shoppingRevision.current++;
    setShoppingPending(shoppingEdits.current.length);
    setError("");
    setData((current) => ({ ...current, ...applyShoppingEdit(current, edit) }));

    const saved = shoppingWrites.current.then(async () => {
      const dequeued = performance.now();
      let acknowledged = false;
      let written = dequeued;
      let refreshed = dequeued;
      let outcome: "success" | "error" | "saved_refresh_failed" = "success";

      try {
        await api(
          edit.kind === "order" ? "shopping-order" : "checks",
          "PUT",
          edit.kind === "order"
            ? edit.order
            : {
                key: edit.key,
                checked: edit.checked,
                packages: edit.packages,
                onlyIfAbsent: edit.onlyIfAbsent,
              },
          operationId,
        );
        written = performance.now();
        acknowledged = true;
        shoppingRevision.current++;
        confirmedShopping.current = applyShoppingEdit(confirmedShopping.current, edit);

        if (edit.kind === "order") setToast("Store route saved");

        if (shoppingEdits.current.at(-1) === edit) await refresh(operationId);
        refreshed = performance.now();
      } catch (failure) {
        outcome = acknowledged ? "saved_refresh_failed" : "error";

        if (!acknowledged) written = performance.now();
        refreshed = performance.now();

        const superseded = shoppingEdits.current
          .slice(shoppingEdits.current.indexOf(edit) + 1)
          .some(
            (pending) =>
              pending.kind === edit.kind &&
              (edit.kind === "order" || (pending.kind === "check" && pending.key === edit.key)),
          );

        if (!superseded)
          setError((current) =>
            acknowledged
              ? current ||
                "Your shopping change was saved, but the household could not be refreshed. Reload to retry."
              : failure instanceof ApiError
                ? failure.message
                : "Your shopping change couldn’t be confirmed. Refresh to check the current list before changing it again.",
          );
      } finally {
        browserEvent("browser_shopping_save", {
          operation: edit.kind === "order" ? "shopping-order" : "checks",
          outcome,
          acknowledged,
          queueDepth,
          queueMs: dequeued - started,
          writeMs: written - dequeued,
          refreshMs: acknowledged ? refreshed - written : 0,
          durationMs: performance.now() - started,
          relatedOperationId: operationId,
        });
        shoppingEdits.current = shoppingEdits.current.filter((pending) => pending !== edit);
        shoppingRevision.current++;
        const shopping = shoppingEdits.current.reduce(applyShoppingEdit, confirmedShopping.current);
        setData((current) => ({ ...current, ...shopping }));
        setShoppingPending(shoppingEdits.current.length);
      }

      return acknowledged;
    });

    shoppingWrites.current = saved;

    return saved;
  };

  useEffect(() => {
    refresh().catch((failure) =>
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Household data couldn’t be loaded. Refresh to try loading it again.",
      ),
    );
  }, [refresh]);
  useEffect(() => {
    const viewport = window.matchMedia(mobileViewport);
    const sync = () => setMobileLayout(viewport.matches);
    viewport.addEventListener("change", sync);

    return () => viewport.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!shoppingPending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [shoppingPending]);
  useEffect(() => {
    const sync = () => {
      if (!history.state?.hearth?.key) history.replaceState({ hearth: { key: crypto.randomUUID() } }, "");
      const signature = `${history.state?.hearth?.key ?? ""}:${location.hash}`;

      if (lastHistoryEvent.current === signature) return;
      lastHistoryEvent.current = signature;
      const next = readRoute();
      entries.current.set(history.state.hearth.key, next);
      routeRef.current = next;
      setRoute(next);
      setError("");

      if (loaded) setModalState(resolveModal(next));
    };

    if (loaded && !routeLoaded.current) {
      routeLoaded.current = true;
      const next = routeRef.current;
      const previous = history.state?.hearth;

      if (next.view && !previous?.parent) {
        // A fresh texted link gets an in-app Back destination, not an accidental exit.
        const base = {
          ...next,
          view: undefined,
          id: undefined,
          meal: undefined,
          recipe: undefined,
          date: undefined,
          scale: undefined,
        };

        const key = crypto.randomUUID();
        history.replaceState({ hearth: { key } }, "", routeHash(base));
        entries.current.set(key, base);
        history.pushState(
          { hearth: { key: crypto.randomUUID(), parent: key, parentHash: routeHash(base) } },
          "",
          routeHash(next),
        );
      } else {
        // Reuse the entry on reload; only safe URL state is restored, never a draft.
        history.replaceState({ hearth: previous ?? { key: crypto.randomUUID() } }, "", routeHash(next));

        if (previous?.parent && previous.parentHash)
          entries.current.set(previous.parent, readRoute(previous.parentHash));
      }

      entries.current.set(history.state.hearth.key, routeRef.current);
      setModalState(resolveModal(routeRef.current));
    }

    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);

    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [loaded, resolveModal]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      for (const trigger of [pageOptions.current, weekPicker.current]) {
        const menu = trigger?.closest("details");

        if (menu && event.target instanceof Node && !menu.contains(event.target))
          menu.removeAttribute("open");
      }
    };

    document.addEventListener("pointerdown", dismiss);

    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    pageOptions.current?.closest("details")?.removeAttribute("open");
    const started = performance.now();

    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        browserEvent("browser_navigation", { durationMs: performance.now() - started }),
      ),
    );

    return () => cancelAnimationFrame(frame);
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);

    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!listBuilder || page !== "shopping") {
      setDebouncedBuilderSearch("");

      return;
    }

    const timeout = window.setTimeout(
      () => setDebouncedBuilderSearch(builderSearch.trim().toLowerCase()),
      300,
    );

    return () => window.clearTimeout(timeout);
  }, [builderSearch, listBuilder, page]);

  const navigate = (next: Page) => {
    const patch: Partial<Route> = { ...baseView, page: next };

    if (next !== page) {
      patch.search = "";
      patch.collection = "all";
    }

    updateRoute(patch);
    setModalState(null);
    setError("");
  };

  const finishEditing = (entryKey: string | undefined) => {
    // A background save must not navigate away from where Back/Forward has taken the user.
    if (history.state?.hearth?.key !== entryKey) return;
    // A committed save/delete must not leave a stale editor as the current history entry.
    updateRoute(baseView, true);
    setModalState(null);
    mealDrafts.current.clear();
  };

  const mutate = async (
    path: string,
    method: Parameters<typeof api>[1],
    body: Parameters<typeof api>[2],
    message = "",
    close = false,
  ) => {
    const started = performance.now();
    const operationId = crypto.randomUUID();
    const editingEntry = history.state?.hearth?.key;
    let acknowledged = false;
    let outcome: "success" | "error" | "saved_refresh_failed" = "success";
    setBusy(true);
    setError("");

    try {
      await api(path, method, body, operationId);
      acknowledged = true;
      await refresh(operationId);

      if (close) finishEditing(editingEntry);

      if (message) setToast(message);

      return true;
    } catch (failure) {
      outcome = acknowledged ? "saved_refresh_failed" : "error";

      // A refresh failure cannot undo an acknowledged write, even when no editor closes.
      if (acknowledged) {
        if (close) finishEditing(editingEntry);

        if (message) setToast(message);
        setError(
          close
            ? "Your change was saved, but the household could not be refreshed. Retry to refresh the list."
            : "Your change was saved, but the latest household data is unavailable. Refresh the list before making further changes.",
        );

        return close;
      }

      if (path === "recipes" && failure instanceof ApiError && failure.cause === 409)
        await refresh(operationId).catch(() => {});
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Your change couldn’t be confirmed. Refresh to check the current household before making it again.",
      );

      return false;
    } finally {
      browserEvent("browser_mutation", {
        operation: browserOperation(path),
        outcome,
        acknowledged,
        durationMs: performance.now() - started,
        relatedOperationId: operationId,
      });
      setBusy(false);
    }
  };

  const matchGroceries = async () => {
    const started = performance.now();
    const operationId = crypto.randomUUID();
    let acknowledged = false;
    let outcome: "success" | "error" | "saved_refresh_failed" = "error";
    setBusy(true);
    setError("");

    try {
      const response = await api("groceries/match", "POST", undefined, operationId);
      acknowledged = true;

      const result = Schema.decodeUnknownSync(Schema.Struct({ report: MatchReportSchema }))(
        await response.json(),
      );

      await refresh(operationId).catch((failure) => {
        outcome = "saved_refresh_failed";
        throw failure;
      });
      outcome = "success";

      return result.report;
    } finally {
      browserEvent("browser_mutation", {
        operation: "groceries.match",
        outcome,
        acknowledged,
        durationMs: performance.now() - started,
        relatedOperationId: operationId,
      });
      setBusy(false);
    }
  };

  const addMeal = (date = nextDinnerDate(data.meals, week), recipeId = data.recipes[0]?.id ?? null) =>
    setModal({
      kind: "meal",
      meal: { id: crypto.randomUUID(), recipeId, date, slot: "Dinner", scale: 1, note: "" },
    });

  const newRecipe = () => setModal(resolveModal({ ...routeRef.current, ...baseView, view: "editor" }));

  const weekMeals = data.meals.filter((meal) => meal.date >= week && meal.date <= addDays(week, 6));

  const selectedCollection = data.collections.find((collection) => collection.id === collectionFilter);

  const addedOrder = useMemo(
    () => new Map(data.recipesAdded.map((id, index) => [id, index])),
    [data.recipesAdded],
  );

  const matchingRecipes = data.recipes
    .filter(
      (recipe) =>
        matchesRecipeSearch(recipe, search) &&
        (collectionFilter === "uncollected"
          ? !recipe.category
          : !selectedCollection || recipe.category === selectedCollection.name),
    )
    .sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

      if (recipeSort === "az") return byTitle;

      if (recipeSort === "za") return -byTitle;

      const added = (addedOrder.get(a.id) ?? addedOrder.size) - (addedOrder.get(b.id) ?? addedOrder.size);

      return (recipeSort === "newest" ? -added : added) || byTitle;
    });

  const catalog = useMemo(
    () => shoppingList(data.groceries, data.shoppingOrder, data.checks),
    [data.groceries, data.shoppingOrder, data.checks],
  );

  const isChecked = (key: string) => (data.checks.find((entry) => entry.key === key)?.checked ?? 1) === 1;
  const items = listBuilder ? catalog : catalog.filter((item) => !isChecked(checkKey(item)));

  const visibleItems = listBuilder
    ? items.filter((item) => item.name.toLowerCase().includes(debouncedBuilderSearch))
    : items;

  const completed = items.filter((item) => isChecked(checkKey(item))).length;
  const totalItems = items.length + data.extras.length;
  const totalCompleted = completed + data.extras.filter((item) => item.checked).length;

  // The focused suggestion disappears with the panel, so return focus to the name field.
  const closeExtraMatches = () => {
    setExtraMatches(null);
    extraInput.current?.focus();
  };

  const resetExtra = () => {
    setExtra("");
    setExtraAisle("");
    closeExtraMatches();
  };

  // Quick add saves a minimal catalog item (name and aisle) and puts it on the list in one write.
  const createExtraGrocery = async () => {
    const name = extra.trim();
    setBusy(true);
    await shoppingWrites.current;

    if (
      await mutate(
        "shopping-items",
        "PUT",
        { ...newGrocery(name), aisle: extraAisle.trim() },
        `Added ${name}`,
      )
    )
      resetExtra();
  };

  const addExistingGrocery = (item: GroceryItem) => {
    const key = JSON.stringify(["shopping-list", item.id]);
    const onList = !isChecked(key);

    if (!onList) void saveShoppingEdit({ kind: "check", key, checked: 0 });
    setToast(onList ? `${item.name} is already on your list` : `Added ${item.name}`);
    resetExtra();
  };

  if (page === "recipe-checklist")
    return (
      <RecipeChecklist
        recipes={data.recipes}
        groceries={data.groceries}
        meals={data.meals}
        loaded={loaded}
        error={error}
        search={search}
        setSearch={setSearch}
        selected={route.selected}
        setSelected={(selected) => updateRoute({ selected }, true)}
        showList={route.checklist}
        setShowList={(checklist) => updateRoute({ checklist })}
      />
    );

  return (
    <div
      className={`app-shell${page === "shopping" && (shoppingMode || listBuilder) ? " shopping-mode" : ""}`}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link = event.target instanceof Element ? event.target.closest("a") : null;

        if (link?.target === "_blank") return;
        const href = link?.getAttribute("href");

        if (href && ["#plan", "#recipes", "#shopping", "#groceries", "#recipe-checklist"].includes(href)) {
          event.preventDefault();
          navigate(readRoute(href).page);
        }
      }}
    >
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
            <CalendarDays size={19} /> <span className="nav-label">Meal plan</span>{" "}
            <span className="nav-dot" />
          </a>
          <a
            href="#recipes"
            aria-current={page === "recipes" ? "page" : undefined}
            className={page === "recipes" ? "active" : ""}
          >
            <BookOpen size={19} /> <span className="nav-label">Recipes</span>{" "}
            {loaded && <span className="nav-count">{data.recipes.length}</span>}
          </a>
          <a
            href="#shopping"
            aria-current={page === "shopping" ? "page" : undefined}
            className={page === "shopping" ? "active" : ""}
          >
            <ShoppingBasket size={19} /> <span className="nav-label">Shopping list</span>
          </a>
          <a
            href="#groceries"
            aria-current={page === "groceries" ? "page" : undefined}
            className={page === "groceries" ? "active" : ""}
          >
            <Package size={19} /> <span className="nav-label">Groceries</span>
          </a>
        </nav>
      </aside>
      <main>
        <header className="topbar">
          <a className="mobile-brand" href="#plan" aria-label="Hearth meal plan">
            <img src="/brand/icon-small.svg" alt="Hearth" width="28" height="28" />
          </a>
          <h1>
            {page === "plan"
              ? "Meal plan"
              : page === "recipes"
                ? "Recipes"
                : page === "groceries"
                  ? "Groceries"
                  : "Shopping list"}
          </h1>
          <div className="timer-slot" ref={setTimerHeaderHost} />
          <ShareLink compact />
          {page === "plan" ? (
            <button className="primary page-add" aria-label="Add a meal" onClick={() => addMeal()}>
              <Plus size={17} /> <span>Add meal</span>
            </button>
          ) : page === "recipes" ? (
            <button className="primary page-add" aria-label="Add a recipe" onClick={newRecipe}>
              <Plus size={17} /> <span>Add recipe</span>
            </button>
          ) : page === "groceries" ? (
            <button
              className="primary page-add"
              aria-label="Add grocery item"
              disabled={busy}
              onClick={() => setModal({ kind: "grocery", item: newGrocery() })}
            >
              <Plus size={17} /> <span>Add item</span>
            </button>
          ) : null}
          <details
            className="page-options"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.removeAttribute("open");
                pageOptions.current?.focus();
                event.stopPropagation();
              }
            }}
            onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
                event.currentTarget.removeAttribute("open");
            }}
          >
            <summary ref={pageOptions} aria-label="Page options">
              <MoreHorizontal size={20} />
            </summary>
            <div className="page-options-menu">
              <button
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  const url = feedbackURL(location.href);
                  // Derive structured fields from the redacted URL too: a search could contain a token.
                  const capturedRoute = readRoute(new URL(url).hash);
                  setModal({
                    kind: "feedback",
                    context: {
                      app: { name: "Hearth", build: import.meta.env.HEARTH_BUILD_VERSION },
                      page: {
                        name: page,
                        url,
                        detail: (page === "plan"
                          ? `Meal plan · week of ${readableDate(week)}`
                          : page === "recipes"
                            ? `Recipes${selectedCollection ? ` · ${selectedCollection.name}` : ""}`
                            : page === "shopping"
                              ? `Shopping list · ${listBuilder ? "Build list" : shoppingMode ? "Shopping mode" : "My list"}`
                              : "Groceries"
                        ).slice(0, 300),
                        view: {
                          week: capturedRoute.week,
                          mode: capturedRoute.mode,
                          // Feedback schema v2 still carries the retired Hide checked toggle.
                          hideChecked: false,
                          collection: capturedRoute.collection.slice(0, 200),
                          search: capturedRoute.search.slice(0, 300),
                          selected: capturedRoute.selected.slice(0, 100).map((id) => id.slice(0, 200)),
                          checklist: capturedRoute.checklist,
                        },
                      },
                      browser: {
                        userAgent: navigator.userAgent.slice(0, 1000),
                        language: navigator.language.slice(0, 50),
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 100),
                        display:
                          matchMedia("(display-mode: standalone)").matches ||
                          ("standalone" in navigator && navigator.standalone === true)
                            ? "standalone"
                            : "browser",
                        viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
                        touchPoints: navigator.maxTouchPoints,
                        pointer: matchMedia("(pointer: coarse)").matches
                          ? "coarse"
                          : matchMedia("(pointer: fine)").matches
                            ? "fine"
                            : "none",
                        online: navigator.onLine,
                      },
                    },
                  });
                }}
              >
                <Pencil size={16} /> File a ticket
              </button>
              {page === "shopping" && (
                <>
                  <button
                    aria-pressed={arranging}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      updateRoute({ mode: arranging ? "list" : "arrange" });
                    }}
                  >
                    <SlidersHorizontal size={16} /> {arranging ? "Done arranging" : "Arrange route"}
                  </button>
                  <button
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      navigate("groceries");
                    }}
                  >
                    <Package size={16} /> Manage grocery items
                  </button>
                </>
              )}
              {page === "recipes" && (
                <>
                  <button
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setError("");
                      setModal({ kind: "import" });
                    }}
                  >
                    <ArrowDownToLine size={16} /> Import recipe
                  </button>
                  <button
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setError("");
                      setModal({ kind: "collections" });
                    }}
                  >
                    <SlidersHorizontal size={16} /> Manage collections
                  </button>
                </>
              )}
              <button
                aria-label="Use Hearth in ChatGPT"
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  setModal({ kind: "chatgpt" });
                }}
              >
                <MessageCircle size={18} /> Use Hearth in ChatGPT
              </button>
            </div>
          </details>
        </header>
        {error && !modal && (
          <div className="error" role="alert">
            {error}{" "}
            <button
              onClick={() => {
                setError("");
                refresh().catch((failure) =>
                  setError(
                    failure instanceof ApiError
                      ? failure.message
                      : "Household data couldn’t be loaded. Refresh to try loading it again.",
                  ),
                );
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
            {page === "groceries" && (
              <GroceryManager
                groceries={data.groceries}
                recipes={data.recipes}
                search={search}
                setSearch={setSearch}
                busy={busy}
                edit={(item) => setModal({ kind: "grocery", item })}
                editRecipe={(recipe) => setModal({ kind: "editor", recipe })}
                match={matchGroceries}
              />
            )}
            {data.recipes.length === 0 && (page === "plan" || page === "recipes") && (
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
                    <button
                      className="icon-button"
                      aria-label="Previous week"
                      onClick={() => setWeek(addDays(week, -7))}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <details
                      className="date-disclosure week-picker"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.currentTarget.removeAttribute("open");
                          weekPicker.current?.focus();
                          event.stopPropagation();
                        }
                      }}
                    >
                      <summary ref={weekPicker} aria-label="Jump to date">
                        <h2>
                          {readableDate(week, { month: "short", day: "numeric" })}
                          {week.slice(0, 4) !== addDays(week, 6).slice(0, 4) && (
                            <span>, {week.slice(0, 4)}</span>
                          )}
                          {" – "}
                          {readableDate(addDays(week, 6), { month: "short", day: "numeric" })}
                          <span>, {addDays(week, 6).slice(0, 4)}</span>
                        </h2>
                        <ChevronDown size={16} />
                      </summary>
                      <form
                        className="week-jump"
                        key={week}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const date = weekInput.current?.value;

                          if (date && validDate(date)) {
                            setWeek(weekStart(Schema.decodeSync(DateSchema)(date)));
                            event.currentTarget.closest("details")?.removeAttribute("open");
                          }
                        }}
                      >
                        <label htmlFor="week-jump">Jump to date</label>
                        <input
                          id="week-jump"
                          ref={weekInput}
                          type="date"
                          required
                          aria-label="Jump to week containing date"
                          defaultValue={week}
                        />
                        <button
                          type="button"
                          className="secondary"
                          onClick={(event) => {
                            setWeek(weekStart());
                            event.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                        >
                          This week
                        </button>
                        <button className="primary">Go to week</button>
                      </form>
                    </details>
                    <button
                      className="icon-button"
                      aria-label="Next week"
                      onClick={() => setWeek(addDays(week, 7))}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                  <button className="text-button shop-week" onClick={() => navigate("shopping")}>
                    <ShoppingBasket size={17} />
                    <span>Shopping list</span>
                  </button>
                </div>
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
                          <button
                            className="add-day"
                            aria-label={`Add meal for ${readableDate(day)}`}
                            onClick={() => addMeal(day)}
                          >
                            <Plus size={17} />
                          </button>
                        </div>
                        <div className="day-meals">
                          {meals.map((meal) => {
                            const recipe = data.recipes.find((entry) => entry.id === meal.recipeId);

                            if (meal.recipeId !== null && !recipe) return null;

                            return (
                              <MealCard
                                key={meal.id}
                                title={recipe?.title ?? meal.note}
                                noteOnly={!recipe}
                                busy={busy}
                                open={() =>
                                  setModal(recipe ? { kind: "recipe", recipe, meal } : { kind: "meal", meal })
                                }
                                edit={() => setModal({ kind: "meal", meal })}
                                remove={() => {
                                  void mutate(
                                    `meals/${encodeURIComponent(meal.id)}`,
                                    "DELETE",
                                    undefined,
                                    "Meal removed",
                                  );
                                }}
                              >
                                {recipe && (
                                  <div className="meal-photo">
                                    <Photo recipe={recipe} />
                                    <span className="meal-slot">{meal.slot}</span>
                                  </div>
                                )}
                                <div className="meal-content">
                                  {!recipe && <p className="meal-meta">{meal.slot} · Note</p>}
                                  <h3>{recipe ? recipe.title : meal.note}</h3>
                                  {recipe && (
                                    <div className="meal-meta">
                                      <Users size={12} /> {quantity(recipe.servings * meal.scale)} servings{" "}
                                      {meal.scale !== 1 && <span>{quantity(meal.scale)}×</span>}
                                    </div>
                                  )}
                                  {recipe && meal.note && <p className="meal-note">{meal.note}</p>}
                                </div>
                              </MealCard>
                            );
                          })}
                          {meals.length === 0 && (
                            <div className="open-day">
                              <p>No meals planned</p>
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </>
            )}
            {page === "recipes" && (
              <>
                <div className="recipe-toolbar">
                  <label className="search-box">
                    <Search size={18} />
                    <input
                      aria-label="Search recipes"
                      placeholder="Search recipes"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <label className="collection-filter">
                    <span className="sr-only">Collection</span>
                    <BookOpen size={17} aria-hidden="true" />
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
                    <ChevronDown size={16} aria-hidden="true" />
                  </label>
                  <label className="recipe-sort">
                    <span className="sr-only">Sort</span>
                    <ArrowUpDown size={17} aria-hidden="true" />
                    <select
                      aria-label="Sort recipes"
                      value={recipeSort}
                      onChange={(event) => setRecipeSort(event.target.value)}
                    >
                      <option value="az">A–Z</option>
                      <option value="za">Z–A</option>
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                    </select>
                    <ChevronDown size={16} aria-hidden="true" />
                  </label>
                </div>
                <p className="muted small">
                  {matchingRecipes.length} {matchingRecipes.length === 1 ? "recipe" : "recipes"}
                  {selectedCollection && ` · ${selectedCollection.name}`}
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
                        <details className="recipe-rating-picker">
                          <summary aria-label={`Rate ${recipe.title}`}>
                            {recipe.rating === "up" ? (
                              <ThumbsUp size={16} />
                            ) : recipe.rating === "down" ? (
                              <ThumbsDown size={16} />
                            ) : (
                              <Minus size={16} />
                            )}
                            {recipe.rating === "up"
                              ? "Liked"
                              : recipe.rating === "down"
                                ? "Disliked"
                                : "Neutral"}
                          </summary>
                          <div
                            className="recipe-rating"
                            role="group"
                            aria-label={`Rating choices for ${recipe.title}`}
                          >
                            {(["up", "neutral", "down"] as const).map((rating) => (
                              <button
                                key={rating}
                                type="button"
                                className={`rating-${rating}`}
                                aria-label={`${rating === "up" ? "Thumbs up" : rating === "down" ? "Thumbs down" : "Neutral"} for ${recipe.title}`}
                                aria-pressed={recipe.rating === rating}
                                disabled={busy}
                                onClick={(event) => {
                                  event.currentTarget.closest("details")?.removeAttribute("open");
                                  mutate(`recipes/rating/${encodeURIComponent(recipe.id)}`, "PUT", {
                                    rating,
                                  });
                                }}
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
                        </details>
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
                <div className="shopping-summary">
                  <div role="status" className={listBuilder || shoppingMode ? "sr-only" : undefined}>
                    <strong className={shoppingPending > 0 ? "shopping-save-status" : undefined}>
                      {shoppingPending > 0
                        ? "Saving…"
                        : totalItems === 0
                          ? "Empty list"
                          : totalCompleted === totalItems
                            ? "All done!"
                            : `${totalItems - totalCompleted} left`}
                    </strong>
                    <span>
                      {totalCompleted} of {totalItems} checked
                    </span>
                  </div>
                  <div className="shopping-controls">
                    {!listBuilder && !shoppingMode && (
                      <>
                        <button
                          className="secondary"
                          disabled={busy || shoppingPending > 0}
                          onClick={() => {
                            setError("");
                            setModal({ kind: "shopping-recipes" });
                          }}
                        >
                          <BookOpen size={16} /> Add from recipes
                        </button>
                        <a
                          className="secondary"
                          href="#recipe-checklist"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ListChecks size={16} /> Recipe checklist <ExternalLink size={14} />
                        </a>
                      </>
                    )}
                    {!listBuilder && (
                      <button
                        className={shoppingMode ? "primary" : "secondary"}
                        aria-label={shoppingMode ? "Exit shopping mode" : "Shopping mode"}
                        aria-pressed={shoppingMode}
                        onClick={() => {
                          updateRoute({ mode: shoppingMode ? "list" : "focus" });
                        }}
                      >
                        <ShoppingBasket size={16} />
                        {shoppingMode ? "Exit" : "Shop Mode"}
                      </button>
                    )}
                    {!shoppingMode && (
                      <button
                        className={listBuilder ? "primary" : "secondary"}
                        aria-label={listBuilder ? "Exit List Builder" : "List Builder"}
                        aria-pressed={listBuilder}
                        onClick={() => {
                          updateRoute({ mode: listBuilder ? "list" : "builder" });
                        }}
                      >
                        <ListChecks size={16} />
                        {listBuilder ? "Exit Builder" : "List Builder"}
                      </button>
                    )}
                  </div>
                </div>
                {listBuilder && (
                  <div className="builder-toolbar">
                    <p className="field-hint builder-hint" id="builder-hint">
                      Uncheck an item to add it to your list. Checked items are off the list.
                    </p>
                    <label className="search-box">
                      <Search size={18} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="Search grocery items"
                        aria-describedby="builder-hint"
                        placeholder="Search grocery items"
                        value={builderSearch}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </label>
                  </div>
                )}
                <div className="shopping-layout">
                  <section className="shopping-panel" aria-label="Grocery shopping list">
                    <ShoppingItems
                      items={visibleItems}
                      groceries={data.groceries}
                      order={data.shoppingOrder}
                      busy={busy}
                      shoppingMode={shoppingMode || listBuilder}
                      listBuilder={listBuilder}
                      arranging={arranging}
                      checked={(item) => isChecked(checkKey(item))}
                      toggle={(item) => {
                        const key = checkKey(item);

                        const pending = shoppingEdits.current.findLast(
                          (edit) => edit.kind === "check" && edit.key === key,
                        );

                        const checked = pending?.kind === "check" ? pending.checked : isChecked(key) ? 1 : 0;
                        void saveShoppingEdit({ kind: "check", key, checked: checked ? 0 : 1 });
                      }}
                      saveOrder={(order) => saveShoppingEdit({ kind: "order", order })}
                      renameAisle={async (from, to) => {
                        setBusy(true);
                        await shoppingWrites.current;

                        return mutate("shopping-aisles", "PUT", { from, to }, "Aisle renamed");
                      }}
                      edit={(item) => setModal({ kind: "grocery", item })}
                    />
                    {listBuilder && items.length > 0 && visibleItems.length === 0 && (
                      <div className="empty-state" role="status">
                        <Search size={32} />
                        <h2>No grocery items found</h2>
                        <p>Try another item name or clear your search.</p>
                      </div>
                    )}
                    {items.length === 0 && (
                      <div className="empty-state">
                        <ShoppingBasket size={32} />
                        <h2>Nothing to shop for just yet</h2>
                        <p>
                          {catalog.length
                            ? "Open List Builder and uncheck the groceries you need."
                            : "Add grocery items to build your shopping list."}
                        </p>
                        <button
                          className="text-button"
                          onClick={() =>
                            catalog.length ? updateRoute({ mode: "builder" }) : navigate("groceries")
                          }
                        >
                          {catalog.length ? "Open List Builder" : "Add grocery items"}{" "}
                          <ArrowRight size={15} />
                        </button>
                      </div>
                    )}
                  </section>
                  <aside className="shopping-side">
                    <section className="extras-panel">
                      <h2>Household extras</h2>
                      <p>Add anything to your list. New items are saved to Groceries for next time.</p>
                      <form
                        className="extra-form"
                        onSubmit={async (event) => {
                          event.preventDefault();

                          // Saving clears the error banner, which would hide a failed queued list change.
                          if (shoppingPending > 0) return;
                          const name = extra.trim();
                          const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
                          const key = normalize(name);

                          // Exact name/alias matches lead; lexical search ignores digits and preparation words.
                          const exact = data.groceries.filter((item) =>
                            [item.name, ...item.aliases].some((alias) => normalize(alias) === key),
                          );

                          const matches = [
                            ...new Set([
                              ...exact,
                              ...new GrocerySearch(data.groceries).candidates(name, name),
                            ]),
                          ].slice(0, 4);

                          if (matches.length) setExtraMatches(matches);
                          else await createExtraGrocery();
                        }}
                      >
                        <input
                          ref={extraInput}
                          aria-label="New household item"
                          placeholder="e.g. coffee, apples, oat milk"
                          required
                          maxLength={150}
                          value={extra}
                          onChange={(event) => {
                            setExtra(event.target.value);
                            setExtraMatches(null);
                          }}
                        />
                        <input
                          className="extra-aisle"
                          aria-label="Aisle for this item (optional)"
                          placeholder="Aisle (optional)"
                          list="extra-aisles"
                          maxLength={150}
                          value={extraAisle}
                          onChange={(event) => setExtraAisle(event.target.value)}
                        />
                        <datalist id="extra-aisles">
                          {aisles.map((aisle) => (
                            <option key={aisle} value={aisle} />
                          ))}
                        </datalist>
                        <button
                          className="primary"
                          aria-label="Add household item"
                          disabled={busy || shoppingPending > 0 || !extra.trim() || extraMatches !== null}
                        >
                          <Plus size={18} />
                        </button>
                      </form>
                      {extraMatches && (
                        <div className="extra-matches" role="group" aria-labelledby="extra-matches-title">
                          <h3 id="extra-matches-title">Did you mean…</h3>
                          {extraMatches.map((item, index) => (
                            <button
                              type="button"
                              className="extra-match"
                              key={item.id}
                              aria-label={`Use existing ${item.name}`}
                              aria-describedby={`extra-match-${index}`}
                              autoFocus={index === 0}
                              disabled={busy}
                              onClick={() => addExistingGrocery(item)}
                            >
                              <span>
                                <strong>{item.name}</strong>
                                <small id={`extra-match-${index}`}>
                                  {item.aisle ? `Aisle ${item.aisle}` : "No aisle"}
                                  {isChecked(JSON.stringify(["shopping-list", item.id]))
                                    ? ""
                                    : " · On your list"}
                                </small>
                              </span>
                              <span className="extra-match-use">Use</span>
                            </button>
                          ))}
                          <div className="extra-match-actions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || shoppingPending > 0}
                              onClick={() => void createExtraGrocery()}
                            >
                              <Plus size={16} /> Create “{extra.trim()}”
                            </button>
                            <button type="button" className="text-button" onClick={closeExtraMatches}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="extra-items">
                        {data.extras.map((item) => (
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
                              onClick={() =>
                                mutate(`extras/${encodeURIComponent(item.id)}`, "DELETE", undefined)
                              }
                            >
                              <X size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  </aside>
                </div>
              </>
            )}
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
      {modal?.kind === "shopping-recipes" && (
        <Dialog
          title="Add from recipes"
          fullScreen={mobileLayout}
          close={() => {
            if (busy) return;
            setModal(null);
            setError("");
          }}
        >
          <ShoppingRecipeForm
            recipes={data.recipes}
            meals={data.meals}
            groceries={data.groceries}
            checks={data.checks}
            busy={busy}
            error={error}
            cancel={() => {
              setModal(null);
              setError("");
            }}
            save={async (items) => {
              setBusy(true);

              const results = await Promise.all(
                items.map(({ id, packages }) =>
                  saveShoppingEdit({
                    kind: "check",
                    key: JSON.stringify(["shopping-list", id]),
                    checked: 0,
                    packages,
                    onlyIfAbsent: true,
                  }),
                ),
              );

              setBusy(false);

              if (results.every(Boolean)) {
                setModal(null);
                setToast(`${items.length} ${items.length === 1 ? "item" : "items"} added to shopping list`);
              }
            }}
          />
        </Dialog>
      )}
      {modal?.kind === "grocery" && (
        <Dialog
          title="Grocery item"
          fullScreen={mobileLayout}
          close={() => {
            if (busy) return;
            setModal(null);
            setError("");
          }}
        >
          <GroceryForm
            key={modal.item.id}
            item={modal.item}
            aisles={aisles}
            busy={busy}
            error={error}
            cancel={() => {
              setModal(null);
              setError("");
            }}
            save={(item) => mutate("groceries", "PUT", item, "Grocery item saved", true)}
            remove={
              data.groceries.some((item) => item.id === modal.item.id)
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
            requestAnimationFrame(() => pageOptions.current?.focus());
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
            key={modal.collection.id}
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
          fullScreen={mobileLayout}
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          <MealForm
            key={modal.meal.id}
            meal={modal.meal}
            recipes={data.recipes}
            busy={busy}
            error={error}
            save={(meal) => mutate("meals", "PUT", meal, "Meal plan updated", true)}
            remove={
              data.meals.some((meal) => meal.id === modal.meal.id)
                ? () =>
                    mutate(
                      `meals/${encodeURIComponent(modal.meal.id)}`,
                      "DELETE",
                      undefined,
                      "Meal removed",
                      true,
                    )
                : undefined
            }
            viewRecipe={(recipe, meal) => setModal({ kind: "recipe", recipe, meal, returnToMeal: true })}
          />
        </Dialog>
      )}
      {modal?.kind === "recipe" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title="Recipe details"
          close={() => {
            setModal(modal.returnToMeal && modal.meal ? { kind: "meal", meal: modal.meal } : null);
            setError("");
          }}
          fullScreen
        >
          <RecipeDetail
            scale={route.scale ?? modal.meal?.scale ?? 1}
            setScale={(scale) => updateRoute({ scale }, true)}
            recipe={data.recipes.find((recipe) => recipe.id === modal.recipe.id) ?? modal.recipe}
            groceries={data.groceries}
            busy={busy}
            error={error}
            selectGrocery={(index, id) => {
              const recipe = data.recipes.find((recipe) => recipe.id === modal.recipe.id) ?? modal.recipe;

              return mutate(
                "recipes",
                "PUT",
                {
                  ...recipe,
                  expectedIngredients: recipe.ingredients,
                  ingredients: recipe.ingredients.map((item, position) =>
                    position === index ? { ...item, groceryItemId: id, grocerySuggestions: undefined } : item,
                  ),
                },
                "Grocery item linked",
              );
            }}
            edit={
              modal.returnToMeal
                ? undefined
                : () =>
                    setModal({
                      kind: "editor",
                      recipe: data.recipes.find((recipe) => recipe.id === modal.recipe.id) ?? modal.recipe,
                    })
            }
            plan={() =>
              modal.meal ? setModal({ kind: "meal", meal: modal.meal }) : addMeal(undefined, modal.recipe.id)
            }
            meal={modal.meal}
            returnToMeal={modal.returnToMeal}
          />
        </Dialog>
      )}
      {modal?.kind === "import" && (
        <Dialog
          timerHost={setTimerDialogHost}
          title="Import a recipe"
          close={() => {
            setModal(null);
            requestAnimationFrame(() => pageOptions.current?.focus());
          }}
        >
          <RecipeImport
            imported={(recipe, warnings) => setModal({ kind: "editor", recipe, warnings, isNew: true })}
          />
        </Dialog>
      )}
      {modal?.kind === "chatgpt" && (
        <Dialog
          title="Use Hearth in ChatGPT"
          close={() => {
            setModal(null);
            requestAnimationFrame(() => pageOptions.current?.focus());
          }}
        >
          <ChatGPTSetup />
        </Dialog>
      )}
      {modal?.kind === "feedback" && (
        <Dialog
          title="File a ticket"
          shareable={false}
          close={() => {
            setModal(null);
            requestAnimationFrame(() => pageOptions.current?.focus());
          }}
        >
          <FeedbackForm
            context={modal.context}
            close={() => {
              setModal(null);
              requestAnimationFrame(() => pageOptions.current?.focus());
            }}
          />
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
          fullScreen={mobileLayout}
        >
          <RecipeForm
            key={modal.recipe.id}
            fullScreen={mobileLayout}
            recipe={modal.recipe}
            latestRecipe={data.recipes.find((recipe) => recipe.id === modal.recipe.id)}
            clearError={() => setError("")}
            collections={data.collections}
            groceries={data.groceries}
            aisles={aisles}
            saveGrocery={(item) => mutate("groceries", "PUT", item, "Grocery item saved")}
            warnings={modal.warnings}
            busy={busy}
            error={error}
            save={(recipe, expectedIngredients) =>
              mutate(
                "recipes",
                "PUT",
                { ...recipe, expectedIngredients: modal.isNew ? null : expectedIngredients },
                modal.isNew
                  ? "Recipe saved. Automatic grocery matches appear after refresh."
                  : "Recipe saved to your collection",
                true,
              )
            }
            remove={
              data.recipes.some((recipe) => recipe.id === modal.recipe.id)
                ? () =>
                    mutate(
                      `recipes/${encodeURIComponent(modal.recipe.id)}`,
                      "DELETE",
                      undefined,
                      "Recipe deleted",
                      true,
                    )
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
  meal: MealDraft;
  recipes: readonly Recipe[];
  busy: boolean;
  error: string;
  save: (meal: MealDraft) => Promise<boolean>;
  remove?: () => Promise<boolean>;
  viewRecipe: (recipe: Recipe, meal: MealDraft) => void;
}) {
  const [draft, setDraft] = useState<MealDraft>(meal);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [debouncedRecipeSearch, setDebouncedRecipeSearch] = useState("");
  const [choosingRecipe, setChoosingRecipe] = useState(false);
  const recipeSearchInput = useRef<HTMLInputElement>(null);
  const recipe = recipes.find((entry) => entry.id === draft.recipeId);
  const noteOnly = draft.recipeId === null;
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
      className="modal-form meal-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (noteOnly ? draft.note.trim() : recipe) save(draft);
      }}
    >
      <div className="meal-form-fields">
        <label>
          Plan type
          <select
            value={noteOnly ? "note" : "recipe"}
            onChange={(event) =>
              setDraft({
                ...draft,
                recipeId: event.target.value === "note" ? null : (meal.recipeId ?? recipes[0]?.id ?? ""),
              })
            }
          >
            <option value="recipe">Recipe</option>
            <option value="note">Note only</option>
          </select>
        </label>
        {!noteOnly && (
          <>
            <label>
              Recipe
              <input
                ref={recipeSearchInput}
                type="search"
                placeholder="Name or ingredient…"
                autoComplete="off"
                value={recipeSearch}
                onChange={(event) => setRecipeSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                aria-describedby={
                  choosingRecipe || recipeSearch.trim() ? "meal-recipe-search-status" : undefined
                }
              />
            </label>
            {(choosingRecipe || recipeSearch.trim()) && (
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
                            setChoosingRecipe(false);
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
            {recipe && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setRecipeSearch("");
                  setDebouncedRecipeSearch("");
                  setChoosingRecipe(true);
                  recipeSearchInput.current?.focus();
                }}
              >
                Change recipe
              </button>
            )}
          </>
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

                if (slot === "Breakfast" || slot === "Lunch" || slot === "Dinner")
                  setDraft({ ...draft, slot });
              }}
            >
              <option>Breakfast</option>
              <option>Lunch</option>
              <option>Dinner</option>
            </select>
          </label>
        </div>
        {!noteOnly && (
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
        )}
        <label>
          {noteOnly ? (
            "What’s the plan?"
          ) : (
            <>
              A note for this meal <span className="muted">(optional)</span>
            </>
          )}
          <textarea
            placeholder={
              noteOnly
                ? "Pizza, leftovers, dinner out…"
                : "Add chicken, save some for lunch, dinner with friends…"
            }
            required={noteOnly}
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
      </div>
      <div className="form-actions">
        {remove && (
          <button type="button" className="danger text-button" disabled={busy} onClick={remove}>
            <Trash2 size={16} /> Remove meal
          </button>
        )}
        <button className="primary" disabled={busy || (noteOnly ? !draft.note.trim() : !recipe)}>
          {busy ? "Saving…" : "Save"}
          <Check size={16} />
        </button>
      </div>
    </form>
  );
}

function RecipeDetail({
  recipe,
  scale,
  setScale,
  groceries,
  busy,
  error,
  selectGrocery,
  edit,
  plan,
  meal,
  returnToMeal = false,
}: {
  recipe: Recipe;
  scale: number;
  setScale: (scale: number) => void;
  groceries: readonly GroceryItem[];
  busy: boolean;
  error: string;
  selectGrocery: (index: number, id: GroceryId) => Promise<boolean>;
  edit?: () => void;
  plan: () => void;
  meal?: Pick<MealDraft, "scale">;
  returnToMeal?: boolean;
}) {
  return (
    <div className="recipe-detail" tabIndex={0} role="region" aria-label={`${recipe.title} recipe`}>
      <div className="detail-title">
        <span className="category-label">{recipe.category}</span>
        <h1>{recipe.title}</h1>
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
            <button className="text-button" aria-label="Edit recipe" onClick={edit}>
              <Pencil size={14} /> Edit
            </button>
          )}
        </div>
        <div className="recipe-section-nav">
          <a
            href="#recipe-steps"
            onClick={(event) => {
              event.preventDefault();
              const section = document.getElementById("recipe-steps");
              section?.scrollIntoView({ block: "start" });
              section?.focus({ preventScroll: true });
            }}
          >
            Steps
          </a>
          {(returnToMeal || !meal) && (
            <button className="primary" onClick={plan}>
              {returnToMeal ? <ChevronLeft size={16} /> : <Plus size={16} />}{" "}
              {returnToMeal ? "Back to meal" : "Add to meal plan"}
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

              const suggestions = (item.grocerySuggestions ?? []).flatMap((id) => {
                const product = groceries.find((entry) => entry.id === id);

                return product ? [product] : [];
              });

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
                          {grocery.name}
                        </a>
                      ) : (
                        <span className="ingredient-product-link">{grocery.name}</span>
                      )
                    ) : (
                      <span className="ingredient-product-link unlinked">No grocery item linked</span>
                    )}
                  </span>
                  <strong>{displayAmount({ ...item, quantity: item.quantity * scale })}</strong>
                  {!!suggestions.length && (
                    <div
                      className="ingredient-suggestions"
                      role="group"
                      aria-label={`Potential matches for ${item.name}`}
                    >
                      <span>
                        Potential matches <small>Choose the product you use</small>
                      </span>
                      {suggestions.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          disabled={busy}
                          aria-pressed={item.groceryItemId === product.id}
                          onClick={() => selectGrocery(index, product.id)}
                        >
                          <span>
                            {product.name}
                            <small>{displayAmount(product)} per package</small>
                          </span>
                          {item.groceryItemId === product.id ? <Check size={16} /> : <Plus size={16} />}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
        <section id="recipe-steps" tabIndex={-1}>
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
      <details className="recipe-about">
        <summary>About this recipe</summary>
        <Photo recipe={recipe} className="detail-hero" />
        <p>{recipe.description}</p>
      </details>
      <div className="detail-footer">
        {recipe.source ? (
          <a className="text-button" href={recipe.source} target="_blank" rel="noreferrer">
            Recipe source <ExternalLink size={16} />
          </a>
        ) : (
          <span>From our kitchen</span>
        )}
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
      if (active.current)
        setError(
          failure instanceof ApiError
            ? failure.message
            : "The recipe couldn’t be imported. Check the link or add the recipe manually.",
        );
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
      <p>Paste a recipe link. We’ll try to fill in a draft for you to review and save.</p>
      <label>
        Recipe URL
        <input
          type="url"
          required
          autoFocus
          maxLength={4000}
          placeholder="https://example.com/recipe/…"
          value={url}
          disabled={loading}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p className="field-hint">
        Works with sites that share structured recipe data. Some sites block imports. NYT unlocked share links
        are supported, and your original link is kept.
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

function IngredientMatch({
  item,
  groceries,
  index,
  change,
  createProduct,
  busy,
}: {
  item: IngredientDraft;
  groceries: readonly GroceryItem[];
  index: number;
  change: (item: IngredientDraft) => void;
  createProduct: () => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const automatic = item.groceryItemId === undefined ? matchGrocery(item.name, groceries) : undefined;
  const linked = groceries.find((grocery) => grocery.id === (item.groceryItemId ?? automatic?.id));

  const suggestions = (item.grocerySuggestions ?? []).flatMap((id) => {
    const grocery = groceries.find((entry) => entry.id === id);

    return grocery ? [grocery] : [];
  });

  const search = query.trim().toLowerCase();

  const results = [
    ...suggestions,
    ...groceries.filter((grocery) => !suggestions.some((suggestion) => suggestion.id === grocery.id)),
  ].filter((grocery) =>
    [grocery.name, ...grocery.aliases].some((name) => name.toLowerCase().includes(search)),
  );

  const select = (id: IngredientDraft["groceryItemId"]) => {
    change({
      ...item,
      groceryItemId: id,
      grocerySuggestions: id === undefined ? item.grocerySuggestions : undefined,
    });
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="ingredient-match">
      {(item.groceryItemId !== undefined || automatic) && (
        <p className="ingredient-match-status">
          {item.groceryItemId === undefined && automatic
            ? `Auto-match: ${automatic.name}`
            : linked
              ? `Linked: ${linked.name}`
              : "Leave unlinked (manual review)"}
        </p>
      )}
      <label className="ingredient-match-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label={`Grocery item for ingredient ${index + 1}`}
          placeholder="Search grocery items"
          value={query}
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();

            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </label>
      {open && (
        <div
          className="ingredient-match-results"
          role="region"
          aria-label={`Matches for ingredient ${index + 1}`}
        >
          <button
            type="button"
            className="ingredient-create"
            disabled={busy || !item.name.trim()}
            onClick={() => {
              setOpen(false);
              createProduct();
            }}
          >
            <Plus size={16} /> New Product
          </button>
          {results.map((grocery) => (
            <button type="button" key={grocery.id} onClick={() => select(grocery.id)}>
              <strong>{grocery.name}</strong>
              <span>
                {displayAmount(grocery)}
                {suggestions.some((item) => item.id === grocery.id) ? " · Potential match · Jev" : ""}
              </span>
            </button>
          ))}
          {!results.length && (
            <p role="status">
              No grocery items match “{query}”. Try another search or choose New Product above.
            </p>
          )}
          <button type="button" onClick={() => select(undefined)}>
            Auto-match on save
          </button>
          <button type="button" onClick={() => select(null)}>
            Leave unlinked (manual review)
          </button>
        </div>
      )}
    </div>
  );
}

function RecipeForm({
  fullScreen,
  recipe,
  latestRecipe,
  clearError,
  collections,
  groceries,
  aisles,
  saveGrocery,
  warnings,
  busy,
  error,
  save,
  remove,
}: {
  fullScreen: boolean;
  recipe: RecipeDraft;
  latestRecipe?: Recipe;
  clearError: () => void;
  collections: readonly Collection[];
  groceries: readonly GroceryItem[];
  aisles: readonly string[];
  saveGrocery: (item: GroceryDraft) => Promise<boolean>;
  warnings?: readonly string[];
  busy: boolean;
  error: string;
  save: (recipe: RecipeDraft, expectedIngredients: RecipeDraft["ingredients"]) => Promise<boolean>;
  remove?: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<RecipeDraft>({
    ...recipe,
    category: collections.some((collection) => collection.name === recipe.category) ? recipe.category : "",
  });

  const [expectedIngredients, setExpectedIngredients] = useState(recipe.ingredients);

  const [photoError, setPhotoError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [groceryEditor, setGroceryEditor] = useState<{ item: GroceryDraft; index: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);

  const syncIngredients = async () => {
    if (syncing || busy) return;
    setSyncing(true);
    setSyncMessage("");
    setSyncFailed(false);

    try {
      const response = await api("recipes/match", "POST", draft);

      const result = Schema.decodeUnknownSync(
        Schema.Struct({ recipe: RecipeSchema, report: MatchReportSchema }),
      )(await response.json());

      setDraft((current) => ({ ...current, ingredients: result.recipe.ingredients }));
      setSyncFailed(result.report.failed > 0);
      setSyncMessage(
        `${result.report.matched} linked · ${result.report.unmatched} need review · ${result.report.failed} failed. Existing links and exclusions were kept. Save recipe to keep these changes.`,
      );
    } catch (failure) {
      setSyncFailed(true);
      setSyncMessage(
        failure instanceof ApiError
          ? failure.message
          : "Ingredient suggestions couldn’t be loaded. Try syncing again or choose groceries manually; save the recipe to keep your choices.",
      );
    } finally {
      setSyncing(false);
    }
  };

  const updateIngredient = (index: number, ingredient: IngredientDraft) =>
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
        aria-busy={syncing}
        onSubmit={(event) => {
          event.preventDefault();

          if (!syncing) save(draft, expectedIngredients);
        }}
      >
        <div className="recipe-fields">
          <fieldset className="recipe-fields-content" disabled={syncing}>
            {warnings && (
              <div className="field-hint" role="status">
                Review the imported recipe, quantities, and collection before saving. Timing follows the
                source; marinating or resting may be additional.
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            <div className="detail-title recipe-edit-title">
              <label className="recipe-title-field">
                <span className="sr-only">Recipe name</span>
                <textarea
                  aria-label="Recipe name"
                  rows={1}
                  required
                  maxLength={150}
                  placeholder="Grandma’s Sunday pasta"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <div className="detail-meta recipe-edit-meta">
                <label>
                  <Users size={16} />
                  <span className="sr-only">Servings</span>
                  <input
                    aria-label="Servings"
                    type="number"
                    min="0.5"
                    max="100"
                    step="0.5"
                    required
                    value={draft.servings}
                    onChange={(event) => setDraft({ ...draft, servings: event.target.valueAsNumber })}
                  />
                  <span>servings</span>
                </label>
                <label>
                  <Clock3 size={16} />
                  <span className="sr-only">Time (minutes)</span>
                  <input
                    aria-label="Time (minutes)"
                    type="number"
                    min="1"
                    max="10000"
                    required
                    value={draft.minutes}
                    onChange={(event) => setDraft({ ...draft, minutes: event.target.valueAsNumber })}
                  />
                  <span>min</span>
                </label>
                <label>
                  <span className="sr-only">Collection</span>
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
              <p className="field-hint recipe-edit-hint">
                Select any field to edit. Save recipe to keep your changes. Amounts are for one batch.
              </p>
            </div>
            <div className="detail-columns recipe-edit-columns">
              <section className="editor-section">
                <div className="ingredients-heading">
                  <h2>Ingredients</h2>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || syncing}
                    onClick={(event) => {
                      if (event.currentTarget.form?.reportValidity()) void syncIngredients();
                    }}
                  >
                    {syncing ? "Syncing ingredients…" : "Start Grocery Linking"}
                  </button>
                </div>
                {syncMessage && (
                  <p className={syncFailed ? "error" : "field-hint"} role={syncFailed ? "alert" : "status"}>
                    {syncMessage}
                  </p>
                )}
                {draft.ingredients.map((item, index) => {
                  const automatic =
                    item.groceryItemId === undefined ? matchGrocery(item.name, groceries) : undefined;

                  const linked = groceries.find(
                    (entry) => entry.id === (item.groceryItemId ?? automatic?.id),
                  );

                  return (
                    <div className="ingredient-editor" key={index}>
                      <textarea
                        rows={1}
                        aria-label={`Ingredient ${index + 1} name`}
                        placeholder="Ingredient"
                        maxLength={150}
                        required
                        value={item.name}
                        onChange={(event) =>
                          updateIngredient(index, {
                            ...item,
                            name: event.target.value,
                            originalText: undefined,
                            grocerySuggestions: undefined,
                          })
                        }
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
                        onChange={(event) =>
                          updateIngredient(index, {
                            ...item,
                            unit: Schema.decodeUnknownSync(UnitSchema)(event.target.value),
                          })
                        }
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
                      <details className="ingredient-link-editor">
                        <summary>{linked?.name ?? "No grocery item linked"}</summary>
                        <IngredientMatch
                          item={item}
                          groceries={groceries}
                          index={index}
                          change={(ingredient) => updateIngredient(index, ingredient)}
                          createProduct={() =>
                            setGroceryEditor({ item: newGrocery(item.name, item.unit), index })
                          }
                          busy={busy}
                        />
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
                      </details>
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
              </section>
              <section className="editor-section">
                <h2>Let’s make it</h2>
                {draft.instructions.map((step, index) => (
                  <div className="instruction-editor" key={index}>
                    <span>{index + 1}</span>
                    <textarea
                      rows={1}
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
              </section>
            </div>
            <details className="form-details recipe-edit-about">
              <summary>About this recipe</summary>
              <label>
                A few words about it
                <textarea
                  maxLength={2000}
                  placeholder="What makes this one a keeper?"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <details className="form-details">
                <summary>Source & photo (optional)</summary>
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
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setDraft({ ...draft, photo: "" })}
                    >
                      Remove photo
                    </button>
                  )}
                  {photoError && <p className="error">{photoError}</p>}
                </div>
              </details>
            </details>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {error &&
              latestRecipe &&
              JSON.stringify(latestRecipe.ingredients) !== JSON.stringify(expectedIngredients) && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ ...draft, ingredients: latestRecipe.ingredients });
                    setExpectedIngredients(latestRecipe.ingredients);
                    clearError();
                  }}
                >
                  Use latest ingredients and keep other edits
                </button>
              )}
            {confirmDelete && (
              <div className="delete-confirm">
                <p>
                  Delete this recipe permanently? Planned recipes must be removed from the calendar first.
                </p>
                <button type="button" className="danger text-button" disabled={busy} onClick={remove}>
                  Yes, delete recipe
                </button>
                <button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>
                  Keep recipe
                </button>
              </div>
            )}
          </fieldset>
        </div>
        <div className="form-actions">
          {remove && (
            <button
              type="button"
              className="danger text-button"
              disabled={busy || syncing}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} /> Delete recipe
            </button>
          )}
          <button className="primary" disabled={busy || syncing}>
            {busy ? "Saving…" : "Save recipe"}
            <Check size={16} />
          </button>
        </div>
      </form>
      {groceryEditor && (
        <Dialog
          title="Grocery item for ingredient"
          fullScreen={fullScreen}
          close={() => setGroceryEditor(null)}
        >
          <GroceryForm
            key={groceryEditor.item.id}
            item={groceryEditor.item}
            aisles={aisles}
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
