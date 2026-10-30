import { useRef, useState } from "react";
import { Schema } from "effect";
import { ArrowRight, CalendarDays, Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import {
  dateKey,
  DateSchema,
  type GroceryId,
  type ShoppingList,
  type ShoppingListItem,
  type ShoppingListSchema,
} from "./domain";

/** Formats a list date as a weekday and day, adding the year only when it differs from today's. */
export function listDate(date: string, today = dateKey(new Date())) {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

  if (date.slice(0, 4) !== today.slice(0, 4)) options.year = "numeric";

  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", options);
}

/** Names a list by its date and optional label, as shown in pickers and headings. */
export function listName(list: { date: string; label: string }) {
  return `${listDate(list.date)}${list.label ? ` · ${list.label}` : ""}`;
}

function ListForm({
  initial,
  busy,
  submitLabel,
  save,
  cancel,
  remove,
}: {
  initial: { date: string; label: string };
  busy: boolean;
  submitLabel: string;
  save: (draft: { date: string; label: string }) => Promise<boolean>;
  cancel?: () => void;
  remove?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const valid = Schema.is(DateSchema)(draft.date) && draft.label.trim().length <= 100;

  return (
    <form
      className="shopping-list-form"
      onSubmit={async (event) => {
        event.preventDefault();

        if (!busy && valid && (await save({ date: draft.date, label: draft.label.trim() })) && !cancel)
          setDraft(initial);
      }}
    >
      <label>
        Date
        <input
          type="date"
          required
          value={draft.date}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, date: event.target.value })}
        />
      </label>
      <label>
        Label <span className="muted small">(optional)</span>
        <input
          maxLength={100}
          placeholder="e.g. Top-up"
          value={draft.label}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
      </label>
      <div className="shopping-list-form-actions">
        <button className="primary" disabled={busy || !valid}>
          {submitLabel}
        </button>
        {cancel && (
          <button type="button" className="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        )}
        {remove && (
          <button type="button" className="danger" disabled={busy} onClick={remove}>
            <Trash2 size={15} /> Delete list
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * One-line list picker: the current list's name opens a menu of nearby lists, a quick dated "New list",
 * and the full list manager. Upcoming lists come first (soonest first), then the most recent earlier ones.
 */
export function ListSwitcher({
  lists,
  items,
  current,
  busy,
  select,
  create,
  manage,
}: {
  lists: readonly ShoppingList[];
  items: readonly ShoppingListItem[];
  current: ShoppingList;
  busy: boolean;
  select: (list: ShoppingList) => void;
  create: (date: string) => Promise<boolean>;
  manage: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const today = dateKey(new Date());
  const [date, setDate] = useState<string>(today);
  const sorted = [...lists].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const nearby = [
    ...sorted.filter((list) => list.date >= today),
    ...sorted.filter((list) => list.date < today).reverse(),
  ].slice(0, 6);

  const count = (list: ShoppingList) => items.filter((item) => item.listId === list.id).length;

  const close = () => {
    menu.current?.removeAttribute("open");
    menu.current?.querySelector("summary")?.focus();
  };

  const shown = nearby.some((list) => list.id === current.id) ? nearby : [current, ...nearby.slice(0, 5)];

  return (
    <details ref={menu} className="list-switcher" data-dismiss>
      <summary aria-label={`Shopping list: ${listName(current)}. Switch or create a list`}>
        <strong>{listName(current)}</strong>
        <span className="muted small">
          {count(current)} {count(current) === 1 ? "item" : "items"}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="list-switcher-menu">
        <ul aria-label="Shopping lists">
          {shown.map((list) => (
            <li key={list.id}>
              <button
                type="button"
                aria-current={list.id === current.id ? "true" : undefined}
                onClick={() => {
                  close();
                  select(list);
                }}
              >
                <span>{listName(list)}</span>
                <span className="muted small">{count(list)}</span>
                {list.id === current.id && <Check size={15} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="list-switcher-new"
          onSubmit={async (event) => {
            event.preventDefault();

            if (!busy && Schema.is(DateSchema)(date) && (await create(date))) {
              menu.current?.removeAttribute("open");
              setDate(today);
            }
          }}
        >
          <label>
            <span className="sr-only">New list date</span>
            <input
              type="date"
              required
              value={date}
              disabled={busy}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy || !Schema.is(DateSchema)(date)}>
            <Plus size={15} /> New list
          </button>
        </form>
        <button
          type="button"
          className="list-switcher-manage"
          onClick={() => {
            close();
            manage();
          }}
        >
          <CalendarDays size={15} /> All lists…
        </button>
      </div>
    </details>
  );
}

/** Every dated list, upcoming first then earlier, with create, edit, delete and carry-over of unchecked items. */
export function ShoppingLists({
  lists,
  items,
  selected,
  busy,
  error,
  open,
  save,
  remove,
  carryOver,
}: {
  lists: readonly ShoppingList[];
  items: readonly ShoppingListItem[];
  selected: ShoppingList | undefined;
  busy: boolean;
  error: string;
  open: (list: ShoppingList) => void;
  save: (list: typeof ShoppingListSchema.Encoded) => Promise<boolean>;
  remove: (list: ShoppingList) => Promise<boolean>;
  carryOver: (from: ShoppingList, groceryIds: GroceryId[]) => Promise<void>;
}) {
  const today = dateKey(new Date());
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sorted = [...lists].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const upcoming = sorted.filter((list) => list.date >= today);
  const earlier = sorted.filter((list) => list.date < today).reverse();

  const card = (list: ShoppingList) => {
    const entries = items.filter((item) => item.listId === list.id);
    const checked = entries.filter((item) => item.checked).length;

    // Carry over offers only unchecked groceries the selected list doesn't already have.
    const unchecked = entries
      .filter(
        (item) =>
          !item.checked &&
          !items.some((other) => other.listId === selected?.id && other.groceryId === item.groceryId),
      )
      .map((item) => item.groceryId);

    const current = selected?.id === list.id;

    if (editing === list.id)
      return (
        <li className="shopping-list-card editing" key={list.id}>
          {deleting === list.id ? (
            <div className="shopping-list-delete" role="group" aria-label={`Delete ${listName(list)}`}>
              <p>
                Delete the {listName(list)} list and its {entries.length}{" "}
                {entries.length === 1 ? "item" : "items"}? Groceries stay in your catalog. This cannot be
                undone.
              </p>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={async () => {
                  if (await remove(list)) {
                    setDeleting(null);
                    setEditing(null);
                  }
                }}
              >
                Delete list
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setDeleting(null)}>
                Keep it
              </button>
            </div>
          ) : (
            <ListForm
              initial={{ date: list.date, label: list.label }}
              busy={busy}
              submitLabel="Save"
              save={async (draft) => {
                const saved = await save({ ...list, ...draft });

                if (saved) setEditing(null);

                return saved;
              }}
              cancel={() => setEditing(null)}
              remove={() => setDeleting(list.id)}
            />
          )}
        </li>
      );

    return (
      <li className={`shopping-list-card${current ? " current" : ""}`} key={list.id}>
        <button
          type="button"
          className="shopping-list-open"
          aria-current={current ? "true" : undefined}
          onClick={() => open(list)}
        >
          <span>
            <strong>{listName(list)}</strong>
            <span className="muted small">
              {entries.length
                ? `${entries.length} ${entries.length === 1 ? "item" : "items"} · ${checked} checked`
                : "No items yet"}
            </span>
          </span>
          {entries.length > 0 && (
            <span className="shopping-list-progress" aria-hidden="true">
              <i style={{ width: `${(checked / entries.length) * 100}%` }} />
            </span>
          )}
          <ArrowRight size={16} />
        </button>
        <div className="shopping-list-card-actions">
          <button
            type="button"
            className="text-button"
            aria-label={`Edit ${listName(list)}`}
            disabled={busy}
            onClick={() => {
              setDeleting(null);
              setEditing(list.id);
            }}
          >
            <Pencil size={13} /> Edit
          </button>
          {selected && !current && unchecked.length > 0 && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void carryOver(list, unchecked)}
            >
              <Plus size={13} /> Add {unchecked.length} unchecked to {listName(selected)}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="modal-form shopping-lists">
      <section aria-labelledby="new-shopping-list">
        <h3 id="new-shopping-list">New list</h3>
        <ListForm
          initial={{ date: today, label: "" }}
          busy={busy}
          submitLabel="Create list"
          save={(draft) => save({ id: crypto.randomUUID(), ...draft })}
        />
      </section>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {upcoming.length > 0 && (
        <section aria-labelledby="upcoming-shopping-lists">
          <h3 id="upcoming-shopping-lists">Upcoming</h3>
          <ul className="shopping-list-cards">{upcoming.map(card)}</ul>
        </section>
      )}
      {earlier.length > 0 && (
        <section aria-labelledby="earlier-shopping-lists">
          <h3 id="earlier-shopping-lists">Earlier</h3>
          <ul className="shopping-list-cards">{earlier.map(card)}</ul>
        </section>
      )}
      {!lists.length && <p className="muted">No shopping lists yet. Create one for your next shop.</p>}
    </div>
  );
}
