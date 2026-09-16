import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Defence in depth behind public/frame-guard.js: never mount the wallet inside
// another page's frame, even if the guard stylesheet was somehow removed.
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/**
 * Registers the service worker, which exists so the wallet can be installed as
 * an app and so a connection failure shows something better than a dead page.
 * It caches nothing — see public/sw.js for why that matters here.
 *
 * Never inside a frame: a worker registered from a framed page would be scoped
 * to this origin regardless, and nothing about this page should run there.
 */
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    // Failure is not worth surfacing: it costs installability and the offline
    // screen, and nothing else. The wallet works exactly the same without it.
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  });
}

if (!isFramed()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  registerServiceWorker();
}
