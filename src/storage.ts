import { Data, Effect, Option, Schema } from "effect";
import { record } from "./observability";

export class ValidationError extends Data.TaggedError("ValidationError")<{ message: string }> {}

export class MissingReference extends Data.TaggedError("MissingReference")<{ message: string }> {}

export class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}

export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {}

export class StorageError extends Data.TaggedError("StorageError")<{ cause: unknown }> {}

export class StoredDataError extends Data.TaggedError("StoredDataError")<{ cause: unknown }> {}

export type HouseholdError =
  | ValidationError
  | MissingReference
  | NotFound
  | Conflict
  | StorageError
  | StoredDataError;

// A rejected D1 call does not establish whether a write committed. Never retry it here.
export const database = Effect.fn("db.call")(function* <A>(run: () => Promise<A>) {
  const started = performance.now();

  const result = yield* Effect.tryPromise({ try: run, catch: (cause) => new StorageError({ cause }) }).pipe(
    Effect.tapError(() =>
      record("database_call", {
        durationMs: performance.now() - started,
        outcome: "error",
        reason: "StorageError",
      }),
    ),
  );

  const durationMs = performance.now() - started;

  const decoded = Schema.decodeUnknownOption(Schema.Union([DatabaseResult, Schema.Array(DatabaseResult)]))(
    result,
  );

  if (Option.isNone(decoded)) {
    yield* record("database_call", { durationMs });

    return result;
  }

  const results = Array.isArray(decoded.value) ? decoded.value : [decoded.value];
  yield* record("database_call", {
    durationMs,
    outcome: "success",
    batchSize: results.length,
    rowsRead: results.reduce((sum, item) => sum + (item.meta.rows_read ?? 0), 0),
    rowsWritten: results.reduce((sum, item) => sum + (item.meta.rows_written ?? 0), 0),
    changes: results.reduce((sum, item) => sum + (item.meta.changes ?? 0), 0),
    sqlMs: results.reduce(
      (sum, item) => sum + (item.meta.timings?.sql_duration_ms ?? item.meta.duration ?? 0),
      0,
    ),
    attempts: results.reduce((sum, item) => sum + (item.meta.total_attempts ?? 1), 0),
  });

  return result;
});

const DatabaseResult = Schema.Struct({
  meta: Schema.Struct({
    rows_read: Schema.optional(Schema.Number),
    rows_written: Schema.optional(Schema.Number),
    changes: Schema.optional(Schema.Number),
    duration: Schema.optional(Schema.Number),
    total_attempts: Schema.optional(Schema.Number),
    timings: Schema.optional(Schema.Struct({ sql_duration_ms: Schema.Number })),
  }),
});

export const stored = <A>(decode: () => A) =>
  Effect.try({ try: decode, catch: (cause) => new StoredDataError({ cause }) }).pipe(
    Effect.withSpan("storage.decode", {}, { captureStackTrace: false }),
  );
