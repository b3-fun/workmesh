// The console's stylesheets, in the order its entry loads them (b3os-beta apps/web/src/app/main.tsx), then the
// board's own few rules.
import "./b3os/ds/core.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./b3os/styles/index.css";
import "./b3os/styles/app.css";
import "./board.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
