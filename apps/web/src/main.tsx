import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { bootstrapGatewayToken } from "./lib/gateway-auth";
import "./index.css";

bootstrapGatewayToken();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {/* Hosted deployments meet the door first; self-hosted passes straight through. */}
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
