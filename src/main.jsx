import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./Auth";
import { DemoShell } from "./Demo";
import { DEMO, installFetchGuard } from "./demoRuntime";
import "./index.css";

// /?demo: no sign-in, the published snapshot, nothing leaves the browser.
if (DEMO) installFetchGuard();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {DEMO ? (
      <DemoShell><App /></DemoShell>
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </React.StrictMode>
);
