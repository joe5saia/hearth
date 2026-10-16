import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

/** Touch gestures affect only this planned meal; ordinary activation still opens its recipe. */
export function MealCard({
  title,
  noteOnly,
  busy,
  open,
  edit,
  remove,
  children,
}: {
  title: string;
  noteOnly: boolean;
  busy: boolean;
  open: () => void;
  edit: () => void;
  remove: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);

  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    start: number;
    offset: number;
    swiping: boolean;
    timer?: number;
  } | null>(null);

  const suppressClick = useRef(false);
  const heldPointer = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);

  useLayoutEffect(() => {
    const panel = actions.current;
    const anchor = root.current?.querySelector(".meal-actions-toggle");

    if (!menu || !panel || !anchor) return;
    // The native top layer escapes the calendar's mobile/tablet overflow clipping.
    panel.showPopover();
    const button = anchor.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(16, Math.min(button.right - box.width, innerWidth - box.width - 16))}px`;
    panel.style.top = `${Math.max(16, Math.min(button.bottom, innerHeight - box.height - 16))}px`;
  }, [menu]);

  const cancelGesture = () => {
    if (gesture.current?.timer !== undefined) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  };

  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.type === "pointerdown") heldPointer.current = false;

      if (
        event.type === "pointerdown" &&
        event.target instanceof Node &&
        root.current?.contains(event.target)
      )
        return;

      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;

        if (root.current?.querySelector(".meal-actions")?.contains(document.activeElement))
          root.current.querySelector<HTMLButtonElement>(".meal-actions-toggle")?.focus();
      }

      cancelGesture();
      setDragging(false);
      setOffset(0);
      setMenu(false);
    };

    // Opening a dialog mid-hold retargets the compatibility click into the new dialog.
    const suppressHeldClick = (event: MouseEvent) => {
      if (!heldPointer.current || event.detail === 0) return;
      heldPointer.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("click", suppressHeldClick, true);
    document.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);

    return () => {
      cancelGesture();
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("click", suppressHeldClick, true);
      document.removeEventListener("keydown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  return (
    <div
      className={`meal-card-row${menu ? " actions-open" : ""}${offset !== 0 ? " is-revealed" : ""}`}
      ref={root}
    >
      <button
        type="button"
        className="meal-swipe-delete"
        aria-label={`Delete meal ${title}`}
        hidden={offset === 0}
        tabIndex={offset === -88 ? 0 : -1}
        disabled={busy}
        onClick={remove}
      >
        <Trash2 size={20} /> Delete
      </button>
      <button
        type="button"
        className={`meal-card${noteOnly ? " note-only-card" : ""}${dragging ? " is-swiping" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        disabled={busy}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          suppressClick.current = false;

          if (event.pointerType === "mouse" || !event.isPrimary || busy) return;
          cancelGesture();
          setMenu(false);

          const pending: NonNullable<typeof gesture.current> = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: performance.now(),
            offset,
            swiping: false,
          };

          if (offset === 0)
            pending.timer = window.setTimeout(() => {
              suppressClick.current = true;
              heldPointer.current = true;
              cancelGesture();
              edit();
            }, 500);
          gesture.current = pending;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pending = gesture.current;

          if (!pending || pending.id !== event.pointerId) return;
          const dx = event.clientX - pending.x;
          const dy = event.clientY - pending.y;

          if (!pending.swiping) {
            if (Math.hypot(dx, dy) < 8) return;
            window.clearTimeout(pending.timer);
            suppressClick.current = true;

            // Vertical movement belongs to the browser, never to a delayed edit or delete.
            if (Math.abs(dy) >= Math.abs(dx)) {
              cancelGesture();

              return;
            }

            pending.swiping = true;
            setDragging(true);
          }

          setOffset(Math.max(-88, Math.min(0, pending.offset + dx)));
        }}
        onPointerUp={(event) => {
          const pending = gesture.current;

          if (!pending || pending.id !== event.pointerId) return;

          if (pending.swiping) {
            const dx = event.clientX - pending.x;
            const velocity = dx / Math.max(1, performance.now() - pending.start);
            const reveal = Math.abs(velocity) > 0.35 ? dx < 0 : pending.offset + dx < -44;
            setOffset(reveal ? -88 : 0);
          }

          cancelGesture();
          setDragging(false);
        }}
        onPointerCancel={() => {
          setOffset(gesture.current?.offset ?? 0);
          cancelGesture();
          setDragging(false);
          suppressClick.current = true;
        }}
        onLostPointerCapture={() => {
          if (!gesture.current) return;
          setOffset(gesture.current.offset);
          cancelGesture();
          setDragging(false);
        }}
        onClick={(event) => {
          // A swipe or hold also produces a compatibility click on some touch browsers.
          if (event.detail !== 0 && suppressClick.current) {
            suppressClick.current = false;

            return;
          }

          if (offset !== 0) {
            setOffset(0);

            return;
          }

          open();
        }}
      >
        {children}
      </button>
      <button
        type="button"
        className="meal-actions-toggle icon-button"
        aria-label={`Actions for meal ${title}`}
        aria-expanded={menu}
        hidden={offset !== 0}
        disabled={busy}
        onClick={() => setMenu(!menu)}
      >
        <MoreHorizontal size={20} />
      </button>
      {menu && (
        <div ref={actions} popover="manual" className="meal-actions" aria-label={`Meal actions for ${title}`}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              root.current
                ?.querySelector<HTMLButtonElement>(".meal-actions-toggle")
                ?.focus({ preventScroll: true });
              setMenu(false);
              edit();
            }}
          >
            <Pencil size={16} /> Edit meal
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              setMenu(false);
              remove();
            }}
          >
            <Trash2 size={16} /> Delete meal
          </button>
        </div>
      )}
    </div>
  );
}
