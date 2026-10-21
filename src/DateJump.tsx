import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dateKey, type CalendarDate } from "./domain";

/** The Monday-first month picker selects a local date immediately, without a submit step. */
export function DateJump({ date, onSelect }: { date: string; onSelect: (date: CalendarDate) => void }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [month, setMonth] = useState(`${date.slice(0, 7)}-01`);
  const first = new Date(`${month}T12:00:00`);
  const start = addDays(month, -((first.getDay() + 6) % 7));
  const today = dateKey(new Date());
  const title = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target))
        disclosure.current?.removeAttribute("open");
    };

    document.addEventListener("pointerdown", dismiss);

    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  const select = (day: CalendarDate) => {
    disclosure.current?.removeAttribute("open");
    onSelect(day);
  };

  const moveMonth = (offset: number) => {
    const next = new Date(`${month}T12:00:00`);
    next.setMonth(next.getMonth() + offset);
    setMonth(dateKey(next));
  };

  return (
    <details
      ref={disclosure}
      className="date-disclosure date-picker"
      onToggle={(event) => {
        if (event.currentTarget.open) setMonth(`${date.slice(0, 7)}-01`);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.removeAttribute("open");
          trigger.current?.focus();
          event.stopPropagation();
        }
      }}
    >
      <summary ref={trigger}>
        <CalendarDays size={18} /> Jump to date
      </summary>
      <div className="date-picker-panel" aria-label="Choose a date">
        <div className="date-picker-heading">
          <button className="icon-button" aria-label="Previous month" onClick={() => moveMonth(-1)}>
            <ChevronLeft size={20} />
          </button>
          <strong aria-live="polite">{title}</strong>
          <button className="icon-button" aria-label="Next month" onClick={() => moveMonth(1)}>
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="date-picker-grid">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <span className="date-picker-weekday" key={day}>
              {day}
            </span>
          ))}
          {Array.from({ length: 42 }, (_, index) => {
            const day = addDays(start, index);

            return (
              <button
                key={day}
                className={day.slice(0, 7) !== month.slice(0, 7) ? "outside-month" : undefined}
                aria-label={new Date(`${day}T12:00:00`).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
                aria-current={day === today ? "date" : undefined}
                aria-pressed={day === date}
                onClick={() => select(day)}
              >
                {Number(day.slice(-2))}
              </button>
            );
          })}
        </div>
        <button className="secondary date-picker-today" onClick={() => select(today)}>
          Today
        </button>
      </div>
    </details>
  );
}
