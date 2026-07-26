import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {/* Hosted deployments meet the door first; self-hosted passes straight through. */}
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
