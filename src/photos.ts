import { Effect, Schema } from "effect";
import { database, stored, MissingReference, StorageError, ValidationError, NotFound } from "./storage";

const pathSchema = Schema.String.check(Schema.isPattern(/^\/photos\/upload-[a-p]{64}\.jpg$/));

const assetSchema = Schema.Struct({ path: pathSchema, data: Schema.String });

function decodeUpload(photo: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(photo);

  if (!match || !match[2]) throw new Error("Invalid uploaded photo.");
  const binary = atob(match[2]);

  return {
    type: match[1],
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    data: `data:${match[1]};base64,${btoa(binary)}`,
  };
}

/** Prepares assets to run after entity writes in the same transaction; rejected writes create no unused assets. */
export function preparePhoto(db: D1Database, photo: string) {
  return Effect.gen(function* () {
    if (photo.startsWith("/photos/upload-")) {
      const row = yield* database(() =>
        db.prepare("SELECT path FROM photos WHERE path=?").bind(photo).first(),
      );

      if (!row)
        return yield* new MissingReference({
          message: "That uploaded photo no longer exists. Upload it again or choose another photo.",
        });
      yield* stored(() => Schema.decodeUnknownSync(Schema.Struct({ path: pathSchema }))(row));

      return { photo, statements: [] };
    }

    if (!photo.startsWith("data:")) return { photo, statements: [] };

    const upload = yield* Effect.try({
      try: () => decodeUpload(photo),
      catch: () =>
        new ValidationError({
          message: "That photo could not be read. Upload a JPEG, PNG, or WebP image again.",
        }),
    });

    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", upload.bytes),
      catch: (cause) => new StorageError({ cause }),
    });

    // Alphabetic hex keeps old Workers' PhotoSchema compatible during deployment.
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));

    const path = `/photos/upload-${key}.jpg`;

    const hashed = yield* database(() =>
      db.prepare("SELECT path FROM photos WHERE path=?").bind(path).first(),
    );

    // SQL migrations and old Workers cannot hash. Reuse their exact preserved upload.
    const existing =
      hashed ??
      (yield* database(() =>
        db.prepare("SELECT path FROM photos WHERE data=? LIMIT 1").bind(upload.data).first(),
      ));

    if (existing) {
      const saved = yield* stored(() =>
        Schema.decodeUnknownSync(Schema.Struct({ path: pathSchema }))(existing),
      );

      return { photo: saved.path, statements: [] };
    }

    return {
      photo: path,
      statements: [
        db
          .prepare(`INSERT OR IGNORE INTO photos(path,data)
        SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM recipes WHERE photo=?1)
          OR EXISTS (SELECT 1 FROM meals WHERE json_extract(recipe,'$.photo')=?1)`)
          .bind(path, upload.data),
      ],
    };
  });
}

/** Serves private raster bytes only after the website's authentication boundary. Assets are never deleted. */
export function photoResponse(db: D1Database, request: Request) {
  return Effect.gen(function* () {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

    const row = yield* database(() =>
      db.prepare("SELECT path,data FROM photos WHERE path=?").bind(new URL(request.url).pathname).first(),
    );

    if (!row) return yield* new NotFound({ message: "That uploaded photo could not be found." });
    const photo = yield* stored(() => decodeUpload(Schema.decodeUnknownSync(assetSchema)(row).data));

    return new Response(request.method === "HEAD" ? null : photo.bytes, {
      headers: {
        "Content-Type": photo.type,
        "Content-Length": String(photo.bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
