import { Data, Effect, Option, Schema } from "effect";
import { record } from "./observability";

/** Caller input failed validation; message is safe for public responses. */
export class ValidationError extends Data.TaggedError("ValidationError")<{ message: string }> {}

/** A requested related household resource is absent. */
export class MissingReference extends Data.TaggedError("MissingReference")<{ message: string }> {}

/** A requested resource was not found; transports retain their existing status mapping. */
export class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}

/** Current household state prevents the operation; message describes the public conflict. */
export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {}

/** Separate write precondition; omission is rejected rather than interpreted as creation. */
export const ExpectedRevisionSchema = Schema.NullOr(Schema.NonEmptyString);

/** Safe recovery for stale, deleted, and duplicate-create writes. */
export const staleWrite = () =>
  new Conflict({
    message:
      "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
  });

/** Rejects old clients with document-reload guidance, not just a household refetch. */
export const requireRevision = (revision: string | null | undefined) =>
  revision === undefined
    ? Effect.fail(
        new Conflict({
          message:
            "Reload the app to get the latest version before saving or deleting; no changes were applied.",
        }),
      )
    : Effect.succeed(revision);

/** Prioritizes stale-draft recovery over related-resource validation; final writes must still guard atomically. */
export const checkRevision = (
  db: D1Database,
  table: "recipes" | "meals",
  id: string,
  expectedRevision?: string | null,
) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);

    const valid = yield* database(() =>
      db
        .prepare(`SELECT 1 WHERE
      (?2 IS NULL AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id=?1))
      OR EXISTS (SELECT 1 FROM ${table} WHERE id=?1 AND revision=?2)`)
        .bind(id, revision)
        .first(),
    );

    if (!valid) return yield* staleWrite();

    return revision;
  });

/** Deletes exactly the observed version; never treats a missing target as success. */
export const deleteVersion = (
  db: D1Database,
  table: "meals" | "shopping_lists" | "collections",
  id: string,
  expectedRevision?: string | null,
) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);

    const result = yield* database(() =>
      db.prepare(`DELETE FROM ${table} WHERE id=? AND revision=?`).bind(id, revision).run(),
    );

    if (!result.meta.changes) return yield* staleWrite();

    return { ok: true as const };
  });

/** A database call rejected; its private cause does not prove a write failed to commit. */
export class StorageError extends Data.TaggedError("StorageError")<{ cause: unknown }> {}

/** Stored values could not be decoded; keep the underlying cause private. */
export class StoredDataError extends Data.TaggedError("StoredDataError")<{ cause: unknown }> {}

/** Expected shared-operation failures for explicit translation at each transport boundary. */
export type HouseholdError =
  | ValidationError
  | MissingReference
  | NotFound
  | Conflict
  | StorageError
  | StoredDataError;

/** Runs one database call with telemetry and private failure capture, never retrying writes. */
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

/** Captures synchronous stored-data decoding failures separately from database I/O failures. */
export const stored = <A>(decode: () => A) =>
  Effect.try({ try: decode, catch: (cause) => new StoredDataError({ cause }) }).pipe(
    Effect.withSpan("storage.decode", {}, { captureStackTrace: false }),
  );
