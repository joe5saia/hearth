import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { browserEvent, initializeBrowserTelemetry } from "./browser-observability";
import { installDismissal } from "./dismiss";
import { installSelectOnFocus } from "./select-on-focus";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/lora";
// Italic Lora for `.open-day p`; browsers download it only when italic text is shown.
import "@fontsource-variable/lora/wght-italic.css";
import "./styles.css";

const root = document.getElementById("root");

initializeBrowserTelemetry();

installDismissal();

installSelectOnFocus();

if (root)
  createRoot(root, {
    onUncaughtError: () => browserEvent("browser_error", { reason: "render_error", outcome: "error" }),
    onRecoverableError: () =>
      browserEvent("browser_error", { reason: "recoverable_render_error", outcome: "error" }),
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
