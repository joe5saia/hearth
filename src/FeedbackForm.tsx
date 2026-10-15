import { useRef, useState } from "react";
import { Schema } from "effect";
import { ArrowRight, Check, MapPin } from "lucide-react";
import { FeedbackDraftSchema, type FeedbackDraft } from "./feedback-contract";

const draftKey = "hearth-feedback-draft";

const attemptKey = "hearth-feedback-attempt";

/** Preserves one immutable attempted ticket across reloads; Enter sends, and acknowledgement never ships it. */
export function FeedbackForm({ context, close }: { context: FeedbackDraft["context"]; close: () => void }) {
  const [ticket, setTicket] = useState<FeedbackDraft>(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);

      if (saved) return Schema.decodeUnknownSync(FeedbackDraftSchema)(JSON.parse(saved));
    } catch {
      /* Draft storage is optional in private browsing. */
    }

    return { schemaVersion: 2, id: crypto.randomUUID(), request: "", context };
  });

  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const [attempted, setAttempted] = useState(() => {
    try {
      return sessionStorage.getItem(attemptKey) === ticket.id;
    } catch {
      return false;
    }
  });

  const persist = (next: FeedbackDraft) => {
    setTicket(next);

    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      /* Optional storage. */
    }
  };

  const submit = async () => {
    if (sending.current || !ticket.request.trim()) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setAttempted(true);
    const submission = { ...ticket, clientSubmittedAt: ticket.clientSubmittedAt ?? new Date().toISOString() };
    persist(submission);

    try {
      sessionStorage.setItem(attemptKey, ticket.id);
    } catch {
      /* Optional storage. */
    }

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hearth-Operation-Id": ticket.id },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const failure = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
          await response.json(),
        );

        throw new Error(failure.error);
      }

      Schema.decodeUnknownSync(
        Schema.Struct({ id: Schema.Literal(ticket.id), status: Schema.Literal("queued") }),
      )(await response.json());
      setSent(true);

      try {
        sessionStorage.removeItem(draftKey);
        sessionStorage.removeItem(attemptKey);
      } catch {
        /* Optional storage. */
      }
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name === "Error"
          ? failure.message
          : "We couldn’t confirm delivery. Retry safely with this draft.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (sent)
    return (
      <div className="feedback-success" role="status">
        <span className="feedback-check">
          <Check size={24} />
        </span>
        <h3>On its way to Amp</h3>
        <p>
          Your ticket is queued. Amp will work on a separate demo for you to review. Nothing ships
          automatically.
        </p>
        <p className="muted">Ticket {ticket.id.slice(0, 8)}</p>
        <button className="primary" onClick={close}>
          Done
        </button>
      </div>
    );

  return (
    <form
      className="modal-form feedback-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="muted">A small fix or a fresh idea. What would make Hearth better?</p>
      <label htmlFor="feedback-request">Your request</label>
      <textarea
        id="feedback-request"
        autoFocus
        // React focuses on mount; the native attribute also guides dialog.showModal().
        ref={(field) => {
          if (field) field.autofocus = true;
        }}
        required
        rows={4}
        maxLength={4000}
        placeholder="What would you like to change?"
        enterKeyHint="send"
        aria-describedby="feedback-context feedback-hint"
        value={ticket.request}
        readOnly={busy || attempted}
        onChange={(event) => persist({ ...ticket, request: event.target.value })}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <p className="feedback-context" id="feedback-context">
        <MapPin size={15} aria-hidden="true" />
        {ticket.context.page.detail || ticket.context.page.name} · page context included
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="feedback-footer">
        <p className="muted" id="feedback-hint">
          Enter to send · Shift + Enter for a new line
        </p>
        <button className="primary" type="submit" disabled={busy || !ticket.request.trim()}>
          {busy ? "Sending…" : attempted ? "Retry ticket" : "Send ticket"}
          <ArrowRight size={16} />
        </button>
      </div>
      <p className="feedback-privacy muted">
        Sent to Amp for a tested demo, not an automatic release. Don’t include passwords or private household
        details.
      </p>
      {attempted && !busy && (
        <p className="feedback-privacy muted">
          Retrying sends the same ticket, never a second one. Need to write something else?{" "}
          <button
            type="button"
            className="feedback-new"
            onClick={() => {
              persist({ schemaVersion: 2, id: crypto.randomUUID(), request: "", context });
              setAttempted(false);
              setError("");

              try {
                sessionStorage.removeItem(attemptKey);
              } catch {
                /* Optional storage. */
              }
            }}
          >
            Start a new ticket
          </button>
          . The previous ticket may still arrive.
        </p>
      )}
    </form>
  );
}
