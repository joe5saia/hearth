import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { browserEvent, initializeBrowserTelemetry } from "./browser-observability";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/lora";
import "./styles.css";

const root = document.getElementById("root");

initializeBrowserTelemetry();

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
