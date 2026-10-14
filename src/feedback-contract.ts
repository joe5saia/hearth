import { Schema } from "effect";

const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
);

const credentialValue =
  /\bbearer\s|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|https?:\/\/[^/\s?#]*@|(?:[?&#]|^)[^=&]*(?:token|secret|password|passwd|credential|authorization|key|cookie|session|jwt|assertion|signature|code|oauth|auth|state)=/i;

const contextText = (limit: number) =>
  Schema.String.check(
    Schema.isMaxLength(limit),
    Schema.makeFilter((value) => !credentialValue.test(value)),
  );

// Shared by browser capture and server ingestion. Preserve navigation, never URL credentials.
export function feedbackURL(value: string): string {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid feedback URL.");
  url.username = "";
  url.password = "";

  const redact = (params: URLSearchParams) => {
    // Snapshot because set() collapses duplicate keys and would skip later iterator entries.
    for (const [key, value] of Array.from(params)) {
      if (
        /token|secret|password|passwd|credential|authorization|api[-_]?key|access[-_]?key|cookie|session|jwt|assertion|signature|^sig$|^key$|^code$|oauth|^auth$|^state$/i.test(
          key,
        ) ||
        credentialValue.test(value)
      )
        params.set(key, "[redacted]");
    }
  };

  redact(url.searchParams);
  const query = url.hash.indexOf("?");

  if (query >= 0) {
    const params = new URLSearchParams(url.hash.slice(query + 1));
    redact(params);
    url.hash = `${url.hash.slice(0, query)}?${params}`;
  } else if (url.hash.includes("=")) {
    const params = new URLSearchParams(url.hash.slice(1));
    redact(params);
    url.hash = params.toString();
  }

  return url.href;
}

const fields = {
  schemaVersion: Schema.Literal(2),
  id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  ),
  request: Schema.String.check(Schema.isLengthBetween(1, 4000), Schema.isPattern(/\S/)),
  context: Schema.Struct({
    app: Schema.Struct({
      name: Schema.Literal("Hearth"),
      build: Schema.String.check(Schema.isLengthBetween(1, 100)),
    }),
    page: Schema.Struct({
      name: Schema.Literals(["plan", "recipes", "shopping", "groceries", "recipe-checklist"]),
      url: Schema.String.check(Schema.isLengthBetween(1, 4096), Schema.isPattern(/^https?:\/\//)),
      detail: contextText(300),
      view: Schema.Struct({
        week: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
        mode: Schema.Literals(["list", "focus", "builder", "arrange"]),
        hideChecked: Schema.Boolean,
        collection: contextText(200),
        search: contextText(300),
        selected: Schema.Array(contextText(200).check(Schema.isMinLength(1))).check(Schema.isMaxLength(100)),
        checklist: Schema.Boolean,
      }),
    }),
    browser: Schema.Struct({
      userAgent: contextText(1000),
      language: contextText(50),
      timeZone: contextText(100),
      display: Schema.Literals(["browser", "standalone"]),
      viewport: Schema.Struct({
        width: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20000 })),
        height: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20000 })),
        pixelRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 20 })),
      }),
      touchPoints: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 })),
      pointer: Schema.Literals(["coarse", "fine", "none"]),
      online: Schema.Boolean,
    }),
  }),
};

export const FeedbackDraftSchema = Schema.Struct({
  ...fields,
  clientSubmittedAt: Schema.optional(timestamp),
});

export const FeedbackInputSchema = Schema.Struct({ ...fields, clientSubmittedAt: timestamp });

export const FeedbackIdentitySchema = Schema.Struct({
  source: Schema.Literal("cloudflare-access"),
  subject: Schema.String.check(Schema.isLengthBetween(1, 256)),
  email: Schema.optional(
    Schema.String.check(Schema.isLengthBetween(1, 254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  ),
  name: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 200))),
});

export const FeedbackSchema = Schema.Struct({
  ...FeedbackInputSchema.fields,
  delivery: Schema.Struct({
    receivedAt: timestamp,
    environment: Schema.String.check(Schema.isLengthBetween(1, 100)),
    build: Schema.String.check(Schema.isLengthBetween(1, 100)),
    identity: Schema.NullOr(FeedbackIdentitySchema),
    correlation: Schema.Struct({
      operationId: Schema.String.check(
        Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
      ),
      requestId: Schema.String.check(
        Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
      ),
      traceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    }),
  }),
});

export type FeedbackDraft = typeof FeedbackDraftSchema.Type;

export type FeedbackInput = typeof FeedbackInputSchema.Type;

export type Feedback = typeof FeedbackSchema.Type;
