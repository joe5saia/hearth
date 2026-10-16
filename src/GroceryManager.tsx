import { useId, useRef, useState } from "react";
import { Schema } from "effect";
import { Link2, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { displayAmount, units, UnitSchema, type GroceryDraft, type GroceryItem, type Recipe } from "./domain";
import type { MatchReport } from "./domain";
import "./grocery-manager.css";

/** Save and removal callbacks report success; removal is only available for saved products. */
export type GroceryFormProps = {
  item: GroceryDraft;
  aisles: readonly string[];
  busy: boolean;
  error: string;
  save: (item: GroceryDraft) => Promise<boolean>;
  cancel: () => void;
  /** Only provide for products that have already been saved. */
  remove?: () => Promise<boolean>;
};

/** Edits a local product draft and locks its controls while a write is pending. */
export function GroceryForm({ item, aisles, busy, error, save, cancel, remove }: GroceryFormProps) {
  const [draft, setDraft] = useState<GroceryDraft>(item);
  const [editingAlias, setEditingAlias] = useState<number | null>(null);
  const returnToAlias = useRef<number | null>(null);
  const [amount, setAmount] = useState(String(item.quantity));
  const [customAmount, setCustomAmount] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const locked = busy || pending;
  const hintId = useId();
  const aisleId = useId();
  const aisleInput = useRef<HTMLInputElement>(null);
  const [aislesOpen, setAislesOpen] = useState(true);
  const [activeAisle, setActiveAisle] = useState<string | null>(null);
  const [aisleMessage, setAisleMessage] = useState("");
  const aisleQuery = draft.aisle.trim().toLowerCase();
  const matchingAisles = aisles.filter((aisle) => aisle.toLowerCase().includes(aisleQuery));
  const activeAisleIndex = activeAisle === null ? -1 : matchingAisles.indexOf(activeAisle);
  const canCreateAisle = !!aisleQuery && !aisles.some((aisle) => aisle.toLowerCase() === aisleQuery);
  const showAisles = aislesOpen && !locked;

  function selectAisle(aisle: string, create = false) {
    setDraft({ ...draft, aisle });
    setAisleMessage(
      create
        ? `New aisle “${aisle}” will be assigned when you save this grocery item.`
        : `Selected aisle ${aisle}.`,
    );
    aisleInput.current?.focus();
    setAislesOpen(false);
    setActiveAisle(null);
  }

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
              aliases: [...new Set(draft.aliases.map((name) => name.trim()).filter(Boolean))],
            }),
          "Could not confirm whether this grocery item was saved. Refresh the grocery catalog to check its current state.",
        );
      }}
    >
      <div className="grocery-form-fields">
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
        <div
          className="aisle-picker"
          onKeyDown={(event) => {
            if (event.key === "Escape" && showAisles && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              aisleInput.current?.focus();
              setAislesOpen(false);
              setActiveAisle(null);
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setAislesOpen(false);
              setActiveAisle(null);
            }
          }}
        >
          <label htmlFor={aisleId}>Aisle (optional)</label>
          <input
            id={aisleId}
            ref={aisleInput}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showAisles}
            aria-controls={showAisles ? `${aisleId}-list` : undefined}
            aria-activedescendant={
              showAisles && activeAisleIndex >= 0 ? `${aisleId}-option-${activeAisleIndex}` : undefined
            }
            maxLength={150}
            autoComplete="off"
            value={draft.aisle}
            disabled={locked}
            placeholder="Search aisles or enter a new name"
            aria-describedby={`${hintId} ${aisleId}-hint`}
            onFocus={() => setAislesOpen(true)}
            onClick={() => setAislesOpen(true)}
            onChange={(event) => {
              setDraft({ ...draft, aisle: event.target.value });
              setActiveAisle(null);
              setAisleMessage("");
              setAislesOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;

              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setAislesOpen(true);

                const next = matchingAisles.length
                  ? event.key === "ArrowDown"
                    ? (activeAisleIndex + 1) % matchingAisles.length
                    : (activeAisleIndex <= 0 ? matchingAisles.length : activeAisleIndex) - 1
                  : -1;

                setActiveAisle(matchingAisles[next] ?? null);
                requestAnimationFrame(() =>
                  document.getElementById(`${aisleId}-option-${next}`)?.scrollIntoView({ block: "nearest" }),
                );
              } else if (event.key === "Enter" && showAisles && activeAisle !== null) {
                event.preventDefault();

                if (activeAisleIndex >= 0) selectAisle(activeAisle);
                else setActiveAisle(null);
              }
            }}
          />
          {showAisles && (
            <div className="aisle-choices">
              <div id={`${aisleId}-list`} role="listbox" aria-label="Existing aisles" className="aisle-list">
                {matchingAisles.map((aisle, index) => (
                  <button
                    key={aisle}
                    id={`${aisleId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={draft.aisle === aisle}
                    className={activeAisleIndex === index ? "is-active" : ""}
                    tabIndex={-1}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => selectAisle(aisle)}
                  >
                    {aisle}
                  </button>
                ))}
              </div>
              {!matchingAisles.length && (
                <p className="field-hint">
                  {aisles.length ? "No matching aisles." : "No aisles assigned yet."}
                </p>
              )}
              <button
                type="button"
                className="secondary aisle-create"
                disabled={!canCreateAisle}
                onClick={() => selectAisle(draft.aisle.trim(), true)}
              >
                Create new aisle
              </button>
            </div>
          )}
          <p id={`${aisleId}-hint`} className="field-hint" role="status">
            {aisleMessage || "Choose an existing aisle, or type a new name and choose Create new aisle."}
          </p>
        </div>
        <p className="field-hint" id={hintId}>
          You can save without a URL or aisle. Missing details will be marked as setup gaps. Product URLs are
          not fetched.
        </p>
        <section className="grocery-packaging" aria-label="Packaging">
          <h3>Packaging</h3>
          <div className="form-grid">
            <label>
              Package quantity
              <select
                aria-label="Package quantity"
                value={customAmount ? "custom" : amount}
                disabled={locked}
                onChange={(event) => {
                  setCustomAmount(event.target.value === "custom");

                  if (event.target.value !== "custom") setAmount(event.target.value);
                }}
              >
                {[...new Set([0.5, 1, 2, 4, 6, 8, 12, 16, 24, 32, 100, 250, 500, 1000, item.quantity])]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <label>
              Package unit
              <select
                aria-label="Package unit"
                value={draft.unit}
                disabled={locked}
                onChange={(event) =>
                  setDraft({ ...draft, unit: Schema.decodeUnknownSync(UnitSchema)(event.target.value) })
                }
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
          {customAmount && (
            <label>
              Custom package quantity
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
          )}
          <p className="field-hint">Use the size of one package. Counts are never converted to weight.</p>
        </section>
        <section className="grocery-alternatives" aria-label="Alternative ingredient names">
          <h3>Alternative names</h3>
          <ul>
            {draft.aliases.map((alias, index) => (
              <li key={index}>
                {editingAlias === index ? (
                  <input
                    autoFocus
                    aria-label={`Alternative ${index + 1}`}
                    maxLength={150}
                    value={alias}
                    disabled={locked}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        aliases: draft.aliases.map((name, position) =>
                          position === index ? event.target.value : name,
                        ),
                      })
                    }
                    onBlur={() => setEditingAlias(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        returnToAlias.current = index;
                        setEditingAlias(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    ref={(button) => {
                      if (button && returnToAlias.current === index) {
                        returnToAlias.current = null;
                        button.focus({ preventScroll: true });
                      }
                    }}
                    type="button"
                    className="alternative-name"
                    disabled={locked}
                    onClick={() => setEditingAlias(index)}
                  >
                    {alias || "Name this alternative"}
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove alternative ${alias || index + 1}`}
                  disabled={locked}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      aliases: draft.aliases.filter((_, position) => position !== index),
                    });
                    setEditingAlias(null);
                  }}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="text-button"
            disabled={locked || draft.aliases.length >= 100}
            onClick={() => {
              setEditingAlias(draft.aliases.length);
              setDraft({ ...draft, aliases: [...draft.aliases, ""] });
            }}
          >
            <Plus size={15} /> Add Alternative
          </button>
        </section>
        {(error || failure) && (
          <p className="error" role="alert">
            {error || failure}
          </p>
        )}
      </div>
      <div className="form-actions">
        {remove && (
          <button
            type="button"
            className="secondary danger"
            disabled={locked}
            onClick={() => {
              if (!locked)
                void write(
                  remove,
                  "Could not confirm whether this grocery item was deleted. Refresh the grocery catalog to check its current state.",
                );
            }}
          >
            Delete item
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

/** Catalog editing is delegated to callers; matching may update recipe ingredient links. */
export type GroceryManagerProps = {
  groceries: readonly GroceryItem[];
  recipes: readonly Recipe[];
  search: string;
  setSearch: (search: string) => void;
  busy: boolean;
  edit: (item: GroceryItem) => void;
  editRecipe: (recipe: Recipe) => void;
  match: () => Promise<Readonly<MatchReport>>;
};

/** Shows catalog coverage with route-owned search and delegates edit navigation to callers. */
export function GroceryManager({
  groceries,
  recipes,
  search,
  setSearch,
  busy,
  edit,
  editRecipe,
  match,
}: GroceryManagerProps) {
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
        `Matching completed: ${report.matched} linked · ${report.unmatched} need review · ${report.failed} failed · ${report.conflicts} skipped because data changed. Existing links and manual exclusions were kept.${report.failed ? " Review ingredient links for the failed matches." : ""}`,
      );
    } catch {
      setMatchFailed(true);
      setMatchMessage(
        "Could not confirm the ingredient matching result. Refresh recipes to check their current links.",
      );
    } finally {
      setMatching(false);
    }
  }

  return (
    <div className="grocery-manager">
      {matchMessage && (
        <p className={matchFailed ? "error" : "grocery-note"} role={matchFailed ? "alert" : "status"}>
          {matchMessage}
        </p>
      )}
      <section aria-label="Grocery catalog" className="grocery-catalog">
        <label className="grocery-search">
          <span className="sr-only">Search grocery items</span>
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
                    <div className="grocery-metadata">
                      <span>
                        Package: {displayAmount(item)}
                        {item.unit === "each" ? " each" : ""}
                      </span>
                      {item.aisle.trim() ? (
                        <span>Aisle: {item.aisle}</span>
                      ) : (
                        <span className="grocery-gap">Missing aisle</span>
                      )}
                      <span className="grocery-link-status">
                        <Link2 size={14} aria-hidden="true" />
                        {count ? `Linked: ${count} ingredient${count === 1 ? "" : "s"}` : "Not linked"}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="secondary grocery-edit"
                    disabled={locked}
                    onClick={() => edit(item)}
                    aria-label={`Edit grocery item ${item.name}`}
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <details className="grocery-coverage">
        <summary>
          <span>Recipe coverage</span>
          <span className="grocery-note">{total - linked} unlinked</span>
        </summary>
        <div className="grocery-coverage-content">
          <div className="grocery-actions">
            <p className="grocery-note">
              {linked} / {total} ingredients linked
            </p>
            <button type="button" className="secondary" disabled={locked} onClick={() => void retryMatch()}>
              <RefreshCw size={16} aria-hidden="true" />
              {matching ? "Matching…" : "Match ingredients"}
            </button>
          </div>
          <p className="grocery-note">
            Linked products with setup gaps: {missingAisle} missing aisle · {missingUrl} missing URL. A
            product may have both gaps.
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
        </div>
      </details>
    </div>
  );
}
