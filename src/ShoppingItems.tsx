import { useState } from "react";
import { ArrowDown, ArrowUp, Check, ExternalLink, Pencil, Route, TriangleAlert } from "lucide-react";
import {
  compareAisles,
  displayAmount,
  purchaseAmount,
  savedOrder,
  type GroceryItem,
  type ShoppingItem,
  type ShoppingOrder,
} from "./domain";
import "./shopping.css";

function MoveButtons({
  name,
  index,
  length,
  busy,
  move,
}: {
  name: string;
  index: number;
  length: number;
  busy: boolean;
  move: (direction: -1 | 1) => void;
}) {
  return (
    <div className="route-move">
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${name} up`}
        disabled={busy || index === 0}
        onClick={() => move(-1)}
      >
        <ArrowUp size={17} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${name} down`}
        disabled={busy || index === length - 1}
        onClick={() => move(1)}
      >
        <ArrowDown size={17} />
      </button>
    </div>
  );
}

export function ShoppingItems({
  items,
  groceries,
  order,
  busy,
  hideChecked,
  checked,
  toggle,
  saveOrder,
  edit,
  manage,
}: {
  items: readonly ShoppingItem[];
  groceries: readonly GroceryItem[];
  order: ShoppingOrder;
  busy: boolean;
  hideChecked: boolean;
  checked: (item: ShoppingItem) => boolean;
  toggle: (item: ShoppingItem) => void;
  saveOrder: (order: ShoppingOrder) => Promise<boolean>;
  edit: (item: GroceryItem) => void;
  manage: () => void;
}) {
  const [arranging, setArranging] = useState(false);

  const aisles = [...new Set(groceries.map((item) => item.aisle))].sort(
    (a, b) => savedOrder(a, b, order.aisles) || compareAisles(a, b),
  );

  const catalog = [...groceries].sort(
    (a, b) =>
      savedOrder(JSON.stringify(["grocery", a.id]), JSON.stringify(["grocery", b.id]), order.items) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  const groups = [...new Set(items.map((item) => item.grocery?.aisle))];

  const aisleName = (aisle: string | undefined) =>
    aisle === undefined ? "Needs linking" : aisle ? `Aisle ${aisle}` : "No aisle assigned";

  const moveAisle = (index: number, direction: -1 | 1) => {
    const next = [...aisles];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void saveOrder({ ...order, aisles: next });
  };

  const moveItem = (item: GroceryItem, neighbor: GroceryItem) => {
    const next = catalog.map((entry) => JSON.stringify(["grocery", entry.id]));
    const index = catalog.indexOf(item);
    const other = catalog.indexOf(neighbor);
    [next[index], next[other]] = [next[other], next[index]];
    void saveOrder({ ...order, items: next });
  };

  return (
    <>
      <div className="route-toolbar">
        <button className="secondary" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
          <Route size={16} /> {arranging ? "Done arranging" : "Arrange route"}
        </button>
        <button className="text-button" onClick={manage}>
          Manage grocery items
        </button>
      </div>
      {arranging ? (
        <div className="route-editor">
          <p className="field-hint">
            Your whole store, including items not needed this week. Changes save automatically for future
            trips.
          </p>
          <button
            className="text-button"
            disabled={busy || (!order.aisles.length && !order.items.length)}
            onClick={() => saveOrder({ aisles: [], items: [] })}
          >
            Reset to numeric / alphabetical order
          </button>
          {!catalog.length && <p>Add grocery items to arrange your store route.</p>}
          {aisles.map((aisle, index) => {
            const aisleItems = catalog.filter((item) => item.aisle === aisle);

            return (
              <section className="route-aisle" key={aisle} aria-label={`Arrange ${aisleName(aisle)}`}>
                <div className="aisle-heading">
                  <h3>{aisleName(aisle)}</h3>
                  <MoveButtons
                    name={aisleName(aisle)}
                    index={index}
                    length={aisles.length}
                    busy={busy}
                    move={(direction) => moveAisle(index, direction)}
                  />
                </div>
                {aisleItems.map((item, position) => (
                  <div className="route-product" key={item.id}>
                    <span>
                      {item.name}
                      <small>{displayAmount(item)} per package</small>
                    </span>
                    <MoveButtons
                      name={item.name}
                      index={position}
                      length={aisleItems.length}
                      busy={busy}
                      move={(direction) => moveItem(item, aisleItems[position + direction])}
                    />
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="purchase-groups">
          {groups.map((aisle) => {
            const all = items.filter((item) => item.grocery?.aisle === aisle);
            const visible = all.filter((item) => !hideChecked || !checked(item));

            if (!visible.length) return null;

            return (
              <section className="purchase-group" key={aisle ?? "\u0000"} aria-label={aisleName(aisle)}>
                <div className="aisle-heading">
                  <h3>{aisleName(aisle)}</h3>
                  <span>
                    {all.filter(checked).length} / {all.length}
                  </span>
                </div>
                {visible.map((item) => (
                  <div className={`purchase-row ${checked(item) ? "checked" : ""}`} key={item.key}>
                    <label className="shopping-item">
                      <input
                        type="checkbox"
                        checked={checked(item)}
                        disabled={busy}
                        aria-label={`Picked up ${item.name}`}
                        onChange={() => toggle(item)}
                      />
                      <span className="custom-check">
                        <Check size={15} />
                      </span>
                      <span className="item-info">
                        <strong>{item.name}</strong>
                        <span className="purchase-amount">{purchaseAmount(item)}</span>
                        <span className="purchase-need">
                          Need {item.needs.map(displayAmount).join(" + ")}
                        </span>
                      </span>
                    </label>
                    <div className="purchase-details">
                      {item.warnings.map((warning) => (
                        <p className="purchase-warning" key={warning}>
                          <TriangleAlert size={15} />
                          <span>{warning}</span>
                        </p>
                      ))}
                      <p className="purchase-recipes">{item.recipes.join(" · ")}</p>
                      <div className="purchase-links">
                        {item.grocery?.url && (
                          <a href={item.grocery.url} target="_blank" rel="noreferrer">
                            Store product <ExternalLink size={13} />
                          </a>
                        )}
                        {item.grocery ? (
                          <button className="text-button" onClick={() => edit(item.grocery!)}>
                            <Pencil size={13} /> Edit product
                          </button>
                        ) : (
                          <button className="text-button" onClick={manage}>
                            Link ingredients <Pencil size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
