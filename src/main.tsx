import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@warehouse/ui-kit/tokens.css";
import "./styles/floor.css";
import { App } from "./App";
import { registerServiceWorker } from "./pwa/register";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
