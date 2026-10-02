import { Data, Effect } from "effect";

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
export const database = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StorageError({ cause }) });

export const stored = <A>(decode: () => A) =>
  Effect.try({ try: decode, catch: (cause) => new StoredDataError({ cause }) });
