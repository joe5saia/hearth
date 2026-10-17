import { validDate, weekStart } from "./domain";

/** Top-level destinations accepted by the hash router. */
export type Page = "plan" | "recipes" | "shopping" | "groceries" | "recipe-checklist";

/** Dialog destinations layered over a top-level page. */
export type View =
  | "recipe"
  | "editor"
  | "meal"
  | "grocery"
  | "collection"
  | "collections"
  | "import"
  | "chatgpt"
  | "shopping-recipes";

/** Recipe list orders, in menu order; "az" is the default and is omitted from URLs. */
export const recipeSorts = ["az", "za", "newest", "oldest"] as const;

/** Recipe list order: by title, or by when the recipe was added. */
export type RecipeSort = (typeof recipeSorts)[number];

/** Saved navigation state only; unsaved household drafts do not belong in routes. */
export type Route = {
  page: Page;
  week: string;
  mode: "list" | "focus" | "builder" | "arrange";
  collection: string;
  sort: RecipeSort;
  search: string;
  selected: string[];
  checklist: boolean;
  scale?: number;
  view?: View;
  id?: string;
  meal?: string;
  recipe?: string;
  date?: string;
};

const pages: readonly Page[] = ["plan", "recipes", "shopping", "groceries", "recipe-checklist"];

const views: readonly View[] = [
  "recipe",
  "editor",
  "meal",
  "grocery",
  "collection",
  "collections",
  "import",
  "chatgpt",
  "shopping-recipes",
];

/** Parses the hash allowlist, defaulting invalid fields and normalizing the plan week. */
export function readRoute(hash = location.hash): Route {
  const [page, query = ""] = hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const week = params.get("week");
  const mode = params.get("mode");
  const view = params.get("view");
  const date = params.get("date");
  const sort = params.get("sort");
  const scale = Number(params.get("scale"));

  return {
    page: pages.find((candidate) => candidate === page) ?? "plan",
    week: week && validDate(week) ? weekStart(week) : weekStart(),
    mode: mode === "focus" || mode === "builder" || mode === "arrange" ? mode : "list",
    collection: params.get("collection") || "all",
    sort: recipeSorts.find((candidate) => candidate === sort) ?? "az",
    search: params.get("search") || "",
    selected: params.getAll("selected"),
    checklist: params.get("checklist") === "1",
    scale: Number.isFinite(scale) && scale > 0 && scale <= 100 ? scale : undefined,
    view: views.find((candidate) => candidate === view),
    id: params.get("id") || undefined,
    meal: params.get("meal") || undefined,
    recipe: params.get("recipe") || undefined,
    date: date && validDate(date) ? date : undefined,
  };
}

/** Serializes only fields relevant to the page and open dialog, preserving selection order. */
export function routeHash(route: Route): string {
  const params = new URLSearchParams();

  if (route.page === "plan") params.set("week", route.week);

  if (route.page === "shopping") {
    if (route.mode !== "list") params.set("mode", route.mode);
  }

  if (route.page === "recipes" || route.page === "groceries" || route.page === "recipe-checklist") {
    if (route.collection !== "all") params.set("collection", route.collection);

    if (route.search) params.set("search", route.search);
  }

  if (route.page === "recipes" && route.sort !== "az") params.set("sort", route.sort);

  if (route.page === "shopping" && route.mode === "builder" && route.search)
    params.set("search", route.search);

  if (route.page === "recipe-checklist") {
    for (const id of route.selected) params.append("selected", id);

    if (route.checklist) params.set("checklist", "1");
  }

  if (route.view) {
    params.set("view", route.view);

    for (const key of ["id", "meal", "recipe", "date"] as const) {
      if (route[key]) params.set(key, route[key]);
    }

    if (route.view === "recipe" && route.scale !== undefined) params.set("scale", String(route.scale));
  }

  const query = params.toString();

  return `#${route.page}${query ? `?${query}` : ""}`;
}

/** Reconstructs a root URL from the parsed route, excluding auth queries and unknown URL fields. */
export function shareURL(): string {
  return `${location.origin}/${routeHash(readRoute())}`;
}

/** Uses native sharing, falling back to clipboard except on cancellation; clipboard failures reject. */
export async function shareLocation(): Promise<"shared" | "copied" | "cancelled"> {
  const url = shareURL();

  if (navigator.share) {
    try {
      await navigator.share({ title: "Hearth", url });

      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // Some installed browsers expose share but cannot deliver it; still allow copying.
    }
  }

  await navigator.clipboard.writeText(url);

  return "copied";
}
