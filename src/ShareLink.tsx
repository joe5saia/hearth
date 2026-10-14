import { useEffect, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { shareLocation, shareURL } from "./navigation";

export function ShareLink({ compact = false }: { compact?: boolean }) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);

    return () => clearTimeout(timer);
  }, [message]);

  return (
    <>
      <button
        type="button"
        className={compact ? "icon-button" : "text-button"}
        aria-label="Share link"
        title={message || "Share or copy this location. Unsaved draft changes are not included."}
        onClick={async () => {
          try {
            const result = await shareLocation();
            setMessage(result === "copied" ? "Link copied" : result === "shared" ? "Link shared" : "");
          } catch {
            window.prompt("Copy this Hearth link (draft changes are not included):", shareURL());
          }
        }}
      >
        {message ? <Check size={18} /> : <Share2 size={18} />} {!compact && (message || "Share link")}
      </button>
      {message && (
        <span className="sr-only" role="status">
          {message}
        </span>
      )}
    </>
  );
}
