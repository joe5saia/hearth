import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Schema } from "effect";
import { BellRing, ChevronLeft, Plus, Timer, Volume2, X } from "lucide-react";

const storageKey = "hearth-kitchen-timers-v1";

const TimerSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  startedAt: Schema.Number,
  endsAt: Schema.Number,
});

type KitchenTimer = typeof TimerSchema.Type;

function readTimers(): readonly KitchenTimer[] {
  try {
    return Schema.decodeUnknownSync(Schema.Array(TimerSchema))(
      JSON.parse(localStorage.getItem(storageKey) ?? "[]"),
    );
  } catch {
    return [];
  }
}

function remaining(endsAt: number, now: number) {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));

  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function clockTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function romanNumeral(number: number) {
  let numeral = "";

  for (const [value, symbol] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (number >= value) {
      numeral += symbol;
      number -= value;
    }
  }

  return numeral;
}

// Quiet sine tones with soft attack/release, rather than a sharp alarm beep.
function chime(audio: AudioContext) {
  for (const [index, frequency] of [523.25, 659.25].entries()) {
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    const start = audio.currentTime + index * 0.45;
    tone.type = "sine";
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0, start);
    volume.gain.linearRampToValueAtTime(0.12, start + 0.04);
    volume.gain.exponentialRampToValueAtTime(0.001, start + 0.8);
    tone.connect(volume);
    volume.connect(audio.destination);
    tone.start(start);
    tone.stop(start + 0.85);
    tone.onended = () => {
      tone.disconnect();
      volume.disconnect();
    };
  }
}

export function KitchenTimers({
  host,
  recipeName,
  interactive,
}: {
  host: HTMLDivElement | null;
  recipeName: string;
  interactive: boolean;
}) {
  const [timers, setTimers] = useState(readTimers);
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [hours, setHours] = useState("0");
  const [minutes, setMinutes] = useState("10");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [soundReady, setSoundReady] = useState(false);
  const [panelTop, setPanelTop] = useState(72);
  const audio = useRef<AudioContext | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sorted = [...timers].sort((a, b) => a.endsAt - b.endsAt);
  const next = sorted[0];
  const dueCount = timers.filter((timer) => timer.endsAt <= now).length;
  let number = 1;

  while (timers.some((timer) => timer.name === `Timer ${romanNumeral(number)}`)) number++;

  const defaultName = recipeName
    ? Array.from(recipeName.trim()).slice(0, 25).join("").trimEnd()
    : `Timer ${romanNumeral(number)}`;

  const timerName = name ?? defaultName;

  const saveTimers = (nextTimers: readonly KitchenTimer[]) => {
    setTimers(nextTimers);

    try {
      localStorage.setItem(storageKey, JSON.stringify(nextTimers));
      setStorageError("");
    } catch {
      setStorageError("Timers can’t be saved in this browser. Keep this page open.");
    }
  };

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 1000);

    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setTimers(readTimers());
    };

    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("storage", sync);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (!dueCount || !soundReady) return;

    const ring = () => {
      if (audio.current?.state === "running") chime(audio.current);
    };

    ring();
    const interval = window.setInterval(ring, 12000);

    return () => clearInterval(interval);
  }, [dueCount, soundReady]);

  useEffect(() => {
    return () => {
      void audio.current?.close();
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    const header = host?.parentElement;

    if (!header) return;

    const position = () => setPanelTop(header.getBoundingClientRect().bottom);
    const observer = new ResizeObserver(position);
    position();
    observer.observe(header);

    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    if (!open || !interactive) return;

    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus();
      }
    };

    document.addEventListener("keydown", escape);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape);
    };
  }, [open, host, interactive]);

  const enableSound = async (test = false) => {
    try {
      audio.current ??= new AudioContext();
      audio.current.onstatechange = () => setSoundReady(audio.current?.state === "running");
      await audio.current.resume();
      const ready = audio.current.state === "running";
      setSoundReady(ready);

      if (test && ready) chime(audio.current);

      if (!ready) setError("Sound is unavailable. The timer will still flash when it finishes.");
    } catch {
      setSoundReady(false);
      setError("Sound is unavailable. The timer will still flash when it finishes.");
    }
  };

  const collapse = () => {
    setOpen(false);
    toggle.current?.focus();
  };

  const extend = (id: string, minutes: number) => {
    const timestamp = Date.now();
    void enableSound();
    saveTimers(
      timers.map((timer) =>
        timer.id === id ? { ...timer, endsAt: Math.max(timer.endsAt, timestamp) + minutes * 60000 } : timer,
      ),
    );
    setNow(timestamp);
  };

  if (!host) return null;

  return createPortal(
    <div className="kitchen-timers">
      <div className={`timer-header${dueCount ? " timer-due" : ""}`}>
        <button
          ref={toggle}
          className={`timer-toggle${dueCount ? " timer-due" : ""}`}
          aria-expanded={open}
          aria-controls="kitchen-timer-panel"
          onClick={() => {
            void enableSound();
            setOpen(!open);
          }}
        >
          {dueCount ? <BellRing size={20} /> : <Timer size={20} />}
          <span className="timer-toggle-label">
            <small>
              {dueCount
                ? `${dueCount} timer${dueCount === 1 ? "" : "s"} finished`
                : next
                  ? soundReady
                    ? "Next timer due"
                    : "Tap to enable sound"
                  : "Kitchen timers"}
            </small>
            <span>{next?.name ?? "Set a timer"}</span>
          </span>
          {next && <strong className="timer-digits">{remaining(next.endsAt, now)}</strong>}
        </button>
        {next && (
          <div className="timer-header-actions" role="group" aria-label={`Controls for ${next.name}`}>
            <button
              className="icon-button"
              aria-label={`Dismiss timer ${next.name}`}
              title="Dismiss timer"
              onClick={() => {
                saveTimers(timers.filter((timer) => timer.id !== next.id));
                toggle.current?.focus();
              }}
            >
              <X size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={`Add 1 minute to ${next.name}`}
              title="Add 1 minute"
              onClick={() => extend(next.id, 1)}
            >
              <Plus size={13} />
              <span>1m</span>
            </button>
            <button
              className="icon-button"
              aria-label={`Add 5 minutes to ${next.name}`}
              title="Add 5 minutes"
              onClick={() => extend(next.id, 5)}
            >
              <Plus size={13} />
              <span>5m</span>
            </button>
          </div>
        )}
      </div>
      <span className="sr-only" role="status">
        {dueCount
          ? `${dueCount} timer${dueCount === 1 ? "" : "s"} finished. Open kitchen timers to dismiss.`
          : ""}
      </span>
      <aside
        id="kitchen-timer-panel"
        className={`timer-panel${open ? " is-open" : ""}`}
        style={{ top: panelTop }}
        aria-label="Kitchen timers"
        inert={!open}
      >
        <div className="timer-panel-heading">
          <div>
            <h2>Kitchen timers</h2>
            <p>A little help keeping time.</p>
          </div>
          <button ref={closeButton} className="icon-button" aria-label="Collapse timers" onClick={collapse}>
            <ChevronLeft size={22} />
          </button>
        </div>
        <div className="timer-panel-content">
          <details className="timer-create" open={!timers.length}>
            <summary>
              <Plus size={18} /> Add a timer
            </summary>
            <form
              className="timer-form"
              onSubmit={(event) => {
                event.preventDefault();
                const duration = Number(hours) * 60 + Number(minutes);

                if (!timerName.trim() || !Number.isInteger(duration) || duration <= 0) {
                  setError("Add a name and set at least one minute.");

                  return;
                }

                void enableSound();
                const startedAt = Date.now();
                saveTimers([
                  ...timers,
                  {
                    id: crypto.randomUUID(),
                    name: timerName.trim(),
                    startedAt,
                    endsAt: startedAt + duration * 60000,
                  },
                ]);
                setNow(startedAt);
                setName(null);
                setError("");
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              <label>
                Timer name
                <input
                  name="timerName"
                  value={timerName}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Roast vegetables"
                  maxLength={80}
                  required
                />
              </label>
              <div className="timer-duration">
                <label>
                  Hours
                  <input
                    name="timerHours"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="99"
                    step="1"
                    required
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                  />
                </label>
                <label>
                  Minutes
                  <input
                    name="timerMinutes"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="59"
                    step="1"
                    required
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                  />
                </label>
              </div>
              <button className="primary" type="submit">
                <Plus size={18} /> Start timer
              </button>
            </form>
          </details>
          {error && (
            <p className="timer-error" role="alert">
              {error}
            </p>
          )}
          <div className="timer-list">
            {sorted.length === 0 && (
              <p className="timer-empty">
                Nothing on the clock yet. Name what’s cooking and we’ll keep time.
              </p>
            )}
            {sorted.map((timer) => {
              const due = timer.endsAt <= now;

              return (
                <article
                  key={timer.id}
                  className={`timer-card${due ? " timer-due" : ""}`}
                  aria-label={timer.name}
                >
                  <div className="timer-card-heading">
                    <h3>{timer.name}</h3>
                    <span>{due ? "Time’s up" : "Running"}</span>
                  </div>
                  <p className="timer-digits timer-countdown" aria-label="Time remaining">
                    {remaining(timer.endsAt, now)}
                  </p>
                  <span className="timer-units">hours : minutes : seconds</span>
                  <dl>
                    <div>
                      <dt>Started</dt>
                      <dd>
                        <time dateTime={new Date(timer.startedAt).toISOString()}>
                          {clockTime(timer.startedAt)}
                        </time>
                      </dd>
                    </div>
                    <div>
                      <dt>{due ? "Ended" : "Ends"}</dt>
                      <dd>
                        <time dateTime={new Date(timer.endsAt).toISOString()}>{clockTime(timer.endsAt)}</time>
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="secondary"
                    aria-label={`${due ? "Dismiss" : "Cancel"} ${timer.name}`}
                    onClick={() => saveTimers(timers.filter((entry) => entry.id !== timer.id))}
                  >
                    {due ? "Done · dismiss timer" : "Cancel timer"}
                  </button>
                </article>
              );
            })}
          </div>
          <div className="timer-help">
            <button
              className="secondary"
              onClick={() => {
                setError("");
                void enableSound(true);
              }}
            >
              <Volume2 size={18} />
              {soundReady ? "Test chime" : "Enable & test sound"}
            </button>
            <p>
              Keep Hearth open, your device awake, and volume on. Timers stay on this browser; they aren’t
              shared.
            </p>
            {storageError && (
              <p className="timer-error" role="alert">
                {storageError}
              </p>
            )}
          </div>
        </div>
      </aside>
    </div>,
    host,
  );
}
