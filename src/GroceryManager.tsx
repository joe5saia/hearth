import { useId, useState } from "react";
import { Link2, Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { displayAmount, units, type GroceryItem, type Recipe } from "./domain";
import type { MatchReport } from "./domain";
import "./grocery-manager.css";

export type GroceryFormProps = {
  item: GroceryItem;
  busy: boolean;
  error: string;
  save: (item: GroceryItem) => Promise<boolean>;
  cancel: () => void;
  /** Only provide for products that are not linked to any recipe ingredient. */
  remove?: () => Promise<boolean>;
};

export function GroceryForm({ item, busy, error, save, cancel, remove }: GroceryFormProps) {
  const [draft, setDraft] = useState(item);
  const [aliases, setAliases] = useState(item.aliases.join("\n"));
  const [amount, setAmount] = useState(String(item.quantity));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const locked = busy || pending;
  const hintId = useId();

  async function write(operation: () => Promise<boolean>, message: string) {
    setPending(true);
    setFailure("");

    try {
      if (!(await operation())) setFailure(message);
    } catch {
      setFailure(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="modal-form grocery-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (locked) return;
        const quantity = Number(amount);
        const url = draft.url.trim();

        if (!draft.name.trim() || !Number.isFinite(quantity) || quantity <= 0) {
          setFailure("Enter a product name and a positive package quantity.");

          return;
        }

        if (url) {
          try {
            const parsed = new URL(url);

            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
          } catch {
            setFailure("Enter a valid HTTP or HTTPS product URL, or leave it empty.");

            return;
          }
        }

        void write(
          () =>
            save({
              ...draft,
              name: draft.name.trim(),
              url,
              aisle: draft.aisle.trim(),
              quantity,
              aliases: [
                ...new Set(
                  aliases
                    .split("\n")
                    .map((name) => name.trim())
                    .filter(Boolean),
                ),
              ],
            }),
          "Could not save this grocery item. Your changes are still here; please try again.",
        );
      }}
    >
      <label>
        Store product name
        <input
          required
          maxLength={150}
          value={draft.name}
          disabled={locked}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        Product URL (optional)
        <input
          type="url"
          maxLength={4000}
          value={draft.url}
          disabled={locked}
          placeholder="https://…"
          aria-describedby={hintId}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        />
      </label>
      <label>
        Aisle (optional)
        <input
          maxLength={150}
          value={draft.aisle}
          disabled={locked}
          placeholder="e.g. 5 or Bakery"
          aria-describedby={hintId}
          onChange={(event) => setDraft({ ...draft, aisle: event.target.value })}
        />
      </label>
      <p className="field-hint" id={hintId}>
        You can save without a URL or aisle. Missing details will be marked as setup gaps. Product URLs are
        not fetched.
      </p>
      <div className="form-grid">
        <label>
          Package quantity
          <input
            type="number"
            required
            min="0"
            max="1000000"
            step="any"
            value={amount}
            disabled={locked}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          Package unit
          <select
            value={draft.unit}
            disabled={locked}
            onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
          >
            {!units.includes(draft.unit) && <option value={draft.unit}>{draft.unit}</option>}
            {units.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field-hint">Use the size of one package. Counts are never converted to weight.</p>
      <label>
        Alternate ingredient names
        <textarea
          rows={4}
          maxLength={15000}
          value={aliases}
          disabled={locked}
          placeholder={"e.g. plain flour\nall-purpose flour"}
          onChange={(event) => setAliases(event.target.value)}
        />
        <span className="field-hint">
          One name per line. These names match recipe ingredients to this store product.
        </span>
      </label>
      {(error || failure) && (
        <p className="error" role="alert">
          {error || failure}
        </p>
      )}
      {remove && confirmDelete && (
        <div className="grocery-delete-confirm" role="group" aria-label="Confirm grocery item deletion">
          <p>Delete “{item.name}”? This unused product will be removed from the catalog.</p>
          <button
            type="button"
            className="secondary danger"
            disabled={locked}
            onClick={() => {
              if (!locked) void write(remove, "Could not delete this grocery item. Please try again.");
            }}
          >
            Confirm deletion
          </button>
          <button
            type="button"
            className="secondary"
            disabled={locked}
            onClick={() => setConfirmDelete(false)}
          >
            Keep item
          </button>
        </div>
      )}
      <div className="form-actions">
        {remove && !confirmDelete && (
          <button
            type="button"
            className="secondary danger"
            disabled={locked}
            onClick={() => setConfirmDelete(true)}
          >
            Delete unused item
          </button>
        )}
        <button type="button" className="secondary" disabled={locked} onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={locked}>
          {locked ? "Saving…" : "Save grocery item"}
        </button>
      </div>
    </form>
  );
}

export type GroceryManagerProps = {
  groceries: readonly GroceryItem[];
  recipes: readonly Recipe[];
  busy: boolean;
  add: () => void;
  edit: (item: GroceryItem) => void;
  editRecipe: (recipe: Recipe) => void;
  match: () => Promise<Readonly<MatchReport>>;
};

export function GroceryManager({
  groceries,
  recipes,
  busy,
  add,
  edit,
  editRecipe,
  match,
}: GroceryManagerProps) {
  const [search, setSearch] = useState("");
  const [matching, setMatching] = useState(false);
  const [matchMessage, setMatchMessage] = useState("");
  const [matchFailed, setMatchFailed] = useState(false);
  const locked = busy || matching;
  const byId = new Map(groceries.map((item) => [item.id, item]));
  const uses = new Map<string, number>();

  const coverage = recipes.map((recipe) => {
    const unlinked = recipe.ingredients.filter((ingredient) => {
      if (!ingredient.groceryItemId || !byId.has(ingredient.groceryItemId)) return true;
      uses.set(ingredient.groceryItemId, (uses.get(ingredient.groceryItemId) ?? 0) + 1);

      return false;
    });

    return { recipe, unlinked, linked: recipe.ingredients.length - unlinked.length };
  });

  const total = recipes.reduce((count, recipe) => count + recipe.ingredients.length, 0);
  const linked = coverage.reduce((count, row) => count + row.linked, 0);
  const linkedProducts = groceries.filter((item) => uses.has(item.id));
  const missingAisle = linkedProducts.filter((item) => !item.aisle.trim()).length;
  const missingUrl = linkedProducts.filter((item) => !item.url.trim()).length;
  const query = search.trim().toLowerCase();

  const visible = groceries.filter((item) =>
    [item.name, item.aisle, ...item.aliases].join(" ").toLowerCase().includes(query),
  );

  async function retryMatch() {
    if (locked) return;
    setMatching(true);
    setMatchMessage("");

    try {
      const report = await match();
      setMatchFailed(report.failed > 0 || report.conflicts > 0);
      setMatchMessage(
        `Matching completed: ${report.matched} linked · ${report.unmatched} need review · ${report.failed} failed · ${report.conflicts} skipped because data changed. Existing links and manual exclusions were kept.${report.failed ? " Check Cloudflare AI billing/access and retry failed ingredients." : ""}`,
      );
    } catch (error) {
      setMatchFailed(true);
      setMatchMessage(
        error instanceof Error ? error.message : "Could not match ingredients. Please try again.",
      );
    } finally {
      setMatching(false);
    }
  }

  return (
    <div className="grocery-manager">
      <div className="grocery-toolbar">
        <p>Connect recipe ingredients to the products you buy.</p>
        <div className="grocery-actions">
          <button type="button" className="secondary" disabled={locked} onClick={() => void retryMatch()}>
            <RefreshCw size={16} aria-hidden="true" />
            {matching ? "Matching…" : "Match ingredients"}
          </button>
          <button type="button" className="primary" disabled={locked} onClick={add}>
            <Plus size={16} aria-hidden="true" />
            Add grocery item
          </button>
        </div>
      </div>
      {matchMessage && (
        <p className={matchFailed ? "error" : "grocery-note"} role={matchFailed ? "alert" : "status"}>
          {matchMessage}
        </p>
      )}
      <section aria-label="Grocery catalog" className="grocery-catalog">
        <label className="grocery-search">
          <span>Search grocery items</span>
          <div>
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={search}
              placeholder="Product, ingredient name, or aisle"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </label>
        <p className="grocery-note" role="status">
          {visible.length} of {groceries.length} grocery items
        </p>
        {visible.length === 0 ? (
          <p className="grocery-empty">
            {groceries.length
              ? "No grocery items match your search."
              : "Your catalog is empty. Add a store product, then match it to recipe ingredients."}
          </p>
        ) : (
          <ul className="grocery-items">
            {visible.map((item) => {
              const count = uses.get(item.id) ?? 0;

              return (
                <li key={item.id} className="grocery-item">
                  <div className="grocery-product">
                    <h2>{item.name}</h2>
                    <p>
                      Package: {displayAmount(item)}
                      {item.unit === "each" ? " each" : ""}
                    </p>
                    <p className="grocery-link-status">
                      <Link2 size={14} aria-hidden="true" />
                      {count
                        ? `Linked to ${count} recipe ingredient${count === 1 ? "" : "s"}`
                        : "Not linked to any recipe ingredients"}
                    </p>
                  </div>
                  <div className="grocery-setup">
                    <p>
                      {item.aisle.trim() ? (
                        `Aisle: ${item.aisle}`
                      ) : (
                        <span className="grocery-gap">Missing aisle</span>
                      )}
                    </p>
                    {item.url.trim() ? (
                      <span>Product URL added</span>
                    ) : (
                      <span className="grocery-gap">Missing URL</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked}
                    onClick={() => edit(item)}
                    aria-label={`Edit grocery item ${item.name}`}
                  >
                    <Pencil size={15} aria-hidden="true" />
                    Edit
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="grocery-coverage" aria-labelledby="grocery-coverage-heading">
        <h2 id="grocery-coverage-heading">Recipe coverage</h2>
        <p className="grocery-note">
          {linked} / {total} ingredients linked · {total - linked} unlinked
        </p>
        <p className="grocery-note">
          Linked products with setup gaps: {missingAisle} missing aisle · {missingUrl} missing URL. A product
          may have both gaps.
        </p>
        <p className="grocery-note">
          Match ingredients uses AI to search product and alternate names, then chooses a suitable product
          using the original ingredient and recipe instructions. Uncertain matches stay unlinked. Edit a
          recipe to review or change its links.
        </p>
        {!recipes.length ? (
          <p className="grocery-empty">Add recipes to see ingredient coverage here.</p>
        ) : (
          <ul className="grocery-recipe-list">
            {coverage.map(({ recipe, unlinked, linked: count }) => (
              <li key={recipe.id}>
                <div>
                  <h3>{recipe.title}</h3>
                  <p>
                    {count} / {recipe.ingredients.length} ingredients linked
                  </p>
                  {unlinked.length ? (
                    <p className="grocery-unlinked">
                      Unlinked: {unlinked.map((ingredient) => ingredient.name).join(", ")}
                    </p>
                  ) : (
                    <p className="grocery-note">
                      {recipe.ingredients.length ? "All ingredients linked" : "No ingredients yet"}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={locked}
                  onClick={() => editRecipe(recipe)}
                  aria-label={`Edit recipe ${recipe.title}`}
                >
                  <Pencil size={15} aria-hidden="true" />
                  Edit recipe
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
