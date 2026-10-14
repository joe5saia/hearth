import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { Schema } from "effect";
import { FeedbackSchema } from "../../src/feedback-contract.ts";

const ticket = Schema.decodeUnknownSync(FeedbackSchema)(JSON.parse(await readFile(".amp/feedback-state/validation-ticket.json", "utf8")));
assert(ticket.request.startsWith("Isolated intake validation:"), "Only the disposable smoke ticket may be replayed");
const { signingKey } = JSON.parse(await readFile(".amp/feedback-state/owner.json", "utf8"));
const url = (await readFile(".amp/feedback-state/webhook-url", "utf8")).trim();
for (const control of ["duplicate", "bad-signature", "bad-schema"] as const) {
  const body = JSON.stringify(control === "bad-schema" ? { ...ticket, id: crypto.randomUUID(), project: "must-not-be-used" } : control === "bad-signature" ? { ...ticket, id: crypto.randomUUID() } : ticket);
  const signature = control === "bad-signature" ? "0".repeat(64) : createHmac("sha256", signingKey).update(body).digest("hex");
  try {
    const result = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `validation-${control}-${crypto.randomUUID()}`, "X-Hearth-Signature": signature }, body, signal: AbortSignal.timeout(10000) });
    assert(result.ok, `Control queue returned ${result.status}`);
    console.log(`QUEUED ${control} control; verify the intake ledger still has exactly one execution thread`);
  } catch { throw new Error(`Could not queue ${control} control; credentials and underlying exceptions withheld`); }
}
