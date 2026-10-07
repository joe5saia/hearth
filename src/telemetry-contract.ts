import { Schema } from "effect";

const operations = [
  "household",
  "groceries",
  "groceries.match",
  "shopping-order",
  "collections",
  "recipes",
  "recipes.import",
  "recipes.rating",
  "meals",
  "extras",
  "checks",
  "demo",
  "unknown",
] as const;

export function apiOperation(path: string) {
  const parts = path.split("/");

  if (parts[1] !== "api") return "assets";

  if (parts[2] === "telemetry") return "telemetry";

  if (parts[2] === "recipes" && parts[3] === "import") return "recipes.import";

  if (parts[2] === "recipes" && parts[3] === "rating") return "recipes.rating";

  if (parts[2] === "groceries" && parts[3] === "match") return "groceries.match";

  return operations.find((operation) => operation === parts[2]) ?? "unknown";
}

// Do not censor slow requests or large households at the monitoring boundary.
const duration = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

const uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);

export const BrowserEventSchema = Schema.Struct({
  event: Schema.Literals([
    "browser_request",
    "browser_household",
    "browser_mutation",
    "browser_shopping_save",
    "browser_navigation",
    "browser_vital",
    "browser_error",
    "browser_long_task",
  ]),
  page: Schema.Literals(["plan", "recipes", "shopping", "groceries"]),
  device: Schema.Literals(["narrow", "wide"]),
  operation: Schema.optional(Schema.Literals(operations)),
  outcome: Schema.optional(Schema.Literals(["success", "error", "network_error", "saved_refresh_failed"])),
  reason: Schema.optional(
    Schema.Literals([
      "script_error",
      "resource_error",
      "unhandled_rejection",
      "render_error",
      "recoverable_render_error",
      "decode_error",
    ]),
  ),
  method: Schema.optional(Schema.Literals(["GET", "POST", "PUT", "DELETE"])),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 599 }))),
  durationMs: Schema.optional(duration),
  queueMs: Schema.optional(duration),
  writeMs: Schema.optional(duration),
  refreshMs: Schema.optional(duration),
  downloadMs: Schema.optional(duration),
  decodeMs: Schema.optional(duration),
  queueDepth: Schema.optional(count),
  recipes: Schema.optional(count),
  meals: Schema.optional(count),
  groceries: Schema.optional(count),
  bytes: Schema.optional(count),
  acknowledged: Schema.optional(Schema.Boolean),
  initial: Schema.optional(Schema.Boolean),
  relatedOperationId: Schema.optional(uuid),
  relatedRequestId: Schema.optional(uuid),
  relatedTraceId: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))),
  metric: Schema.optional(Schema.Literals(["LCP", "INP", "CLS", "FCP", "TTFB"])),
  value: Schema.optional(duration),
  rating: Schema.optional(Schema.Literals(["good", "needs-improvement", "poor"])),
  navigationType: Schema.optional(
    Schema.Literals(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"]),
  ),
});

export type BrowserEvent = typeof BrowserEventSchema.Type;

export type BrowserMeasurement = Omit<BrowserEvent, "event" | "page" | "device">;

export const BrowserBatchSchema = Schema.Array(BrowserEventSchema).check(Schema.isLengthBetween(1, 20));
