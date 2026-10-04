import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  GripVertical,
  Pencil,
  Route,
  TriangleAlert,
} from "lucide-react";
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
  shoppingMode,
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
  shoppingMode: boolean;
  hideChecked: boolean;
  checked: (item: ShoppingItem) => boolean;
  toggle: (item: ShoppingItem) => void;
  saveOrder: (order: ShoppingOrder) => Promise<boolean>;
  edit: (item: GroceryItem) => void;
  manage: () => void;
}) {
  const [arranging, setArranging] = useState(false);

  const [dragging, setDragging] = useState<{
    id: string;
    aisle: string;
    startY: number;
    scrollY: number;
    height: number;
    source: number;
    middles: number[];
    initialOffsets: number[];
    moved: boolean;
    offset: number;
    target: number;
  } | null>(null);

  const dragRef = useRef(dragging);
  const rootRef = useRef<HTMLDivElement>(null);
  // Explicit gestures capture visual positions; rollback uses separate untransformed layout positions.
  const positions = useRef(new Map<Element, number>());
  const layoutPositions = useRef(new Map<Element, number>());
  const frame = useRef<number | null>(null);
  const isReordering = dragging !== null;
  const orderKey = JSON.stringify(order);
  const layoutOrder = useRef(orderKey);

  const capturePositions = () => {
    const top = rootRef.current!.getBoundingClientRect().top;
    positions.current = new Map(
      [...rootRef.current!.querySelectorAll("[data-reorder-row]")].map((row) => [
        row,
        row.getBoundingClientRect().top - top,
      ]),
    );
  };

  useLayoutEffect(() => {
    if (isReordering) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rows = [...rootRef.current!.querySelectorAll("[data-reorder-row]")];

    const previous = positions.current.size
      ? positions.current
      : orderKey !== layoutOrder.current
        ? new Map(
            rows.flatMap((row) => {
              const top = layoutPositions.current.get(row);

              return top === undefined
                ? []
                : [[row, top + new DOMMatrixReadOnly(getComputedStyle(row).transform).m42] as const];
            }),
          )
        : new Map<Element, number>();

    positions.current = new Map();
    rows.forEach((row) => row.getAnimations().forEach((animation) => animation.cancel()));
    const top = rootRef.current!.getBoundingClientRect().top;
    layoutPositions.current = new Map(rows.map((row) => [row, row.getBoundingClientRect().top - top]));
    layoutOrder.current = orderKey;

    if (reducedMotion) return;
    rows.forEach((row) => {
      const top = previous.get(row);
      const offset = top === undefined ? 0 : top - layoutPositions.current.get(row)!;

      if (Math.abs(offset) < 1) return;
      row.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], {
        duration: 220,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    });
  }, [orderKey, isReordering]);

  useEffect(() => {
    const root = rootRef.current!;
    let width = root.offsetWidth;
    let height = root.offsetHeight;

    const observer = new ResizeObserver(() => {
      if (width === root.offsetWidth && height === root.offsetHeight) return;
      width = root.offsetWidth;
      height = root.offsetHeight;
      const rows = [...root.querySelectorAll("[data-reorder-row]")];
      rows.forEach((row) => row.getAnimations().forEach((animation) => animation.cancel()));

      if (dragRef.current) setDrag(null);
      const top = root.getBoundingClientRect().top;
      layoutPositions.current = new Map(
        rows.map((row) => [
          row,
          row.getBoundingClientRect().top - top - new DOMMatrixReadOnly(getComputedStyle(row).transform).m42,
        ]),
      );
    });

    observer.observe(root);

    return () => {
      observer.disconnect();

      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    if (shoppingMode) {
      setArranging(false);

      if (dragRef.current) setDrag(null);
    }
  }, [shoppingMode]);

  const setDrag = (drag: typeof dragging) => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }

    if (drag === null && dragRef.current !== null) capturePositions();
    dragRef.current = drag;
    setDragging(drag);
  };

  const rowStyle = (id: string | undefined, aisle: string | undefined, position: number) => {
    if (!dragging || dragging.aisle !== aisle) return undefined;

    if (dragging.id === id) return { transform: `translateY(${dragging.offset}px)` };

    if (!dragging.moved) return { transform: `translateY(${dragging.initialOffsets[position]}px)` };
    const source = dragging.source;

    const offset =
      position > source && position <= dragging.target
        ? -dragging.height
        : position < source && position >= dragging.target
          ? dragging.height
          : 0;

    return { transform: `translateY(${offset}px)` };
  };

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
    capturePositions();
    const next = [...aisles];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void saveOrder({ ...order, aisles: next });
  };

  const moveItem = (item: GroceryItem, neighbor: GroceryItem) => {
    capturePositions();
    const next = catalog.map((entry) => JSON.stringify(["grocery", entry.id]));
    const index = catalog.indexOf(item);
    const other = catalog.indexOf(neighbor);
    const [key] = next.splice(index, 1);
    next.splice(other, 0, key);
    void saveOrder({ ...order, items: next });
  };

  const dragHandle = (item: GroceryItem, aisleItems: readonly GroceryItem[], position: number) =>
    aisleItems.length < 2 ? null : (
      <button
        className="route-drag"
        aria-label={`Drag ${item.name} within ${aisleName(item.aisle)}`}
        disabled={busy}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();

          const rows = [
            ...event.currentTarget.closest("[data-reorder-group]")!.querySelectorAll("[data-reorder-row]"),
          ];

          const visualRects = rows.map((row) => row.getBoundingClientRect());
          // Hand an in-flight settling animation to the pointer without jumping or competing transforms.
          rows.forEach((row) => row.getAnimations().forEach((animation) => animation.cancel()));
          const rects = rows.map((row) => row.getBoundingClientRect());
          const initialOffsets = rects.map((rect, index) => visualRects[index].top - rect.top);
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({
            id: item.id,
            aisle: item.aisle,
            startY: event.clientY,
            scrollY: window.scrollY,
            height: rects[position].height,
            source: position,
            middles: rects.map((rect) => rect.top + rect.height / 2),
            initialOffsets,
            moved: false,
            offset: initialOffsets[position],
            target: position,
          });
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;

          if (drag?.id !== item.id) return;

          let target = position;
          const scrollOffset = window.scrollY - drag.scrollY;
          drag.middles.forEach((middle, index) => {
            if (index === position) return;

            if (index > position && event.clientY + scrollOffset > middle) target = index;

            if (index < position && event.clientY + scrollOffset < middle) target = Math.min(target, index);
          });
          dragRef.current = {
            ...drag,
            moved: true,
            offset: drag.initialOffsets[position] + event.clientY - drag.startY + scrollOffset,
            target,
          };

          if (frame.current === null)
            frame.current = requestAnimationFrame(() => {
              frame.current = null;
              setDragging(dragRef.current);
            });
        }}
        onPointerUp={() => {
          const drag = dragRef.current;
          setDrag(null);

          if (drag?.id === item.id && drag.target !== position) moveItem(item, aisleItems[drag.target]);
        }}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
      >
        <GripVertical size={18} />
      </button>
    );

  return (
    <div ref={rootRef} className={dragging?.moved ? "is-reordering" : undefined}>
      <div className="route-toolbar">
        <button className="secondary" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
          <Route size={16} /> {arranging ? "Done arranging" : "Arrange route"}
        </button>
        <button className="text-button" onClick={manage}>
          Manage grocery items
        </button>
      </div>
      {arranging && !shoppingMode ? (
        <div className="route-editor">
          <p className="field-hint">
            Drag the handles to reorder items within an aisle, or use the arrow buttons. Your whole store is
            shown, including items not needed this week. Changes save automatically for future trips.
          </p>
          <button
            className="text-button"
            disabled={busy || (!order.aisles.length && !order.items.length)}
            onClick={() => {
              capturePositions();
              void saveOrder({ aisles: [], items: [] });
            }}
          >
            Reset to numeric / alphabetical order
          </button>
          {!catalog.length && <p>Add grocery items to arrange your store route.</p>}
          {aisles.map((aisle, index) => {
            const aisleItems = catalog.filter((item) => item.aisle === aisle);

            return (
              <section
                className="route-aisle"
                data-reorder-group
                key={aisle}
                aria-label={`Arrange ${aisleName(aisle)}`}
              >
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
                  <div
                    className={`route-product${dragging?.id === item.id ? " is-dragging" : ""}${dragging?.aisle === aisle && dragging.id !== item.id && aisleItems[dragging.target]?.id === item.id ? " drop-target" : ""}`}
                    data-reorder-row
                    key={item.id}
                    style={rowStyle(item.id, aisle, position)}
                  >
                    {dragHandle(item, aisleItems, position)}
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
            const aisleItems = visible.flatMap((item) => (item.grocery ? [item.grocery] : []));

            if (!visible.length) return null;

            return (
              <section
                className="purchase-group"
                data-reorder-group
                key={aisle ?? "\u0000"}
                aria-label={aisleName(aisle)}
              >
                <div className="aisle-heading">
                  <h3>{aisleName(aisle)}</h3>
                  <span>
                    {all.filter(checked).length} / {all.length}
                  </span>
                </div>
                {visible.map((item, position) => {
                  const isDragging = dragging !== null && dragging.id === item.grocery?.id;

                  const isTarget =
                    dragging !== null &&
                    dragging.aisle === aisle &&
                    !isDragging &&
                    aisleItems[dragging.target]?.id === item.grocery?.id;

                  return (
                    <div
                      className={`purchase-row ${checked(item) ? "checked" : ""}${item.grocery && aisleItems.length > 1 ? " has-drag" : ""}${isDragging ? " is-dragging" : ""}${isTarget ? " drop-target" : ""}`}
                      data-reorder-row
                      key={item.key}
                      style={rowStyle(item.grocery?.id, aisle, position)}
                    >
                      {item.grocery && dragHandle(item.grocery, aisleItems, position)}
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
                          <span className="item-heading">
                            <strong>{item.name}</strong>
                            <span className="purchase-amount">{purchaseAmount(item)}</span>
                          </span>
                          <span className="purchase-need">
                            Need {item.needs.map(displayAmount).join(" + ")}
                            {item.warnings.length > 0 && (
                              <span className="purchase-review">
                                <TriangleAlert size={12} /> Review amount
                              </span>
                            )}
                          </span>
                        </span>
                      </label>
                      <details className="purchase-details">
                        <summary
                          aria-label={`Details for ${item.name}`}
                          aria-description={item.warnings.join(" ") || undefined}
                        >
                          <ChevronDown size={18} />
                        </summary>
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
                      </details>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
