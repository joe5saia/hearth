import { Schema } from "effect";
import { FeedbackSchema } from "./feedback-contract";

export type FeedbackEnv = {
  DB: D1Database;
  FEEDBACK_WEBHOOK_URL?: string;
  FEEDBACK_SIGNING_KEY?: string;
};

// This transport runs only behind the website's household authentication and write guards.
export async function submitFeedback(request: Request, env: FeedbackEnv): Promise<Response> {
  const reply = (error: string, status: number) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

  if (request.method !== "POST") return reply("Use POST to file a ticket.", 405);
  // Bound the actual stream, not an attacker-controlled Content-Length header.
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();

  if (!reader) return reply("Enter your request.", 400);

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      bytes += chunk.value.byteLength;

      if (bytes > 20000) {
        await reader.cancel();

        return reply("Please keep your request under 4,000 characters.", 413);
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  let ticket;

  try {
    const body = new Uint8Array(bytes);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    ticket = Schema.decodeUnknownSync(FeedbackSchema, { onExcessProperty: "error" })(
      JSON.parse(new TextDecoder().decode(body)),
    );
  } catch {
    return reply("Enter a request of up to 4,000 characters with valid page context.", 400);
  }

  const { FEEDBACK_WEBHOOK_URL: webhook, FEEDBACK_SIGNING_KEY: secret } = env;

  if (!webhook || !secret) return reply("Ticket intake isn’t connected yet. Your draft is still here.", 503);
  const body = JSON.stringify(ticket);

  try {
    // Atomic quota plus insert. Reusing an ID must never replace the original ask.
    await env.DB.prepare(`INSERT OR IGNORE INTO feedback(id,body,createdAt)
      SELECT ?,?,? WHERE (SELECT COUNT(*) FROM feedback WHERE createdAt > ?) < 10`)
      .bind(ticket.id, body, Date.now(), Date.now() - 600000)
      .run();

    const saved = await env.DB.prepare("SELECT body,queued FROM feedback WHERE id=?")
      .bind(ticket.id)
      .first<{ body: string; queued: number }>();

    if (!saved) return reply("A few tickets just came in. Please try again in ten minutes.", 429);

    if (saved.body !== body)
      return reply("This ticket already has a different request. Close it and start a new ticket.", 409);

    if (!saved.queued) {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signature = Array.from(
        new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");

      const result = await fetch(webhook, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": ticket.id,
          "X-Hearth-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });

      if (!result.ok)
        return reply("Amp couldn’t receive this ticket yet. Retry safely with the same draft.", 503);
      await env.DB.prepare("UPDATE feedback SET queued=1 WHERE id=?").bind(ticket.id).run();
    }

    return Response.json(
      { id: ticket.id, status: "queued" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Neither exceptions nor outbound response bodies are logged: they may contain capabilities.
    return reply("We couldn’t confirm delivery. Retry safely with the same draft.", 503);
  }
}
