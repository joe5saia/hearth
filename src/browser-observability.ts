import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import { apiOperation, type BrowserEvent, type BrowserMeasurement } from "./telemetry-contract";

let enabled: boolean | undefined;

const queue: BrowserEvent[] = [];

let sending = false;

export function browserOperation(path: string) {
  const operation = apiOperation(`/api/${path}`);

  return operation === "assets" || operation === "telemetry" ? "unknown" : operation;
}

export function browserEvent(event: BrowserEvent["event"], fields: BrowserMeasurement = {}) {
  if (enabled === false || queue.length >= 80) return;

  const page =
    location.hash === "#recipes"
      ? "recipes"
      : location.hash === "#shopping"
        ? "shopping"
        : location.hash === "#groceries"
          ? "groceries"
          : "plan";

  queue.push({ event, page, device: innerWidth < 768 ? "narrow" : "wide", ...fields });
}

export function browserResponse(response: Response, operationId: string) {
  enabled = response.headers.get("X-Hearth-Telemetry") === "1";

  if (!enabled) queue.length = 0;
  const requestId = response.headers.get("X-Hearth-Request-Id") ?? "";
  const traceId = response.headers.get("X-Hearth-Trace-Id") ?? "";

  return {
    relatedOperationId: operationId,
    relatedRequestId: requestId.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)?.[0],
    relatedTraceId: traceId.match(/^[a-f0-9]{32}$/)?.[0],
  };
}

async function flush(hidden = false) {
  if (!enabled || !queue.length || (sending && !hidden)) return;
  const batch = queue.splice(0, 20);
  const body = JSON.stringify(batch);

  if (hidden && navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" })))
    return;
  sending = true;

  try {
    await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best effort: never recurse into telemetry, retry indefinitely, or affect app state.
  } finally {
    sending = false;
  }
}

export function initializeBrowserTelemetry() {
  const vital = (metric: Metric) =>
    browserEvent("browser_vital", {
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      navigationType: metric.navigationType,
    });

  onCLS(vital);
  onFCP(vital);
  onINP(vital);
  onLCP(vital);
  onTTFB(vital);
  window.addEventListener(
    "error",
    (event) =>
      browserEvent("browser_error", {
        reason: event instanceof ErrorEvent ? "script_error" : "resource_error",
        outcome: "error",
      }),
    true,
  );
  window.addEventListener("unhandledrejection", () =>
    browserEvent("browser_error", { reason: "unhandled_rejection", outcome: "error" }),
  );

  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        browserEvent("browser_long_task", { durationMs: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  }

  setInterval(() => void flush(), 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      for (let batch = 0; batch < 4 && queue.length; batch++) void flush(true);
    }
  });
}
