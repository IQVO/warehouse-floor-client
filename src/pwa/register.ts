import { log } from "../lib/log";

/**
 * Registers the app-shell service worker (public/sw.js). Production builds only:
 * in `vite dev` a worker would pin stale modules. Browsers only allow service
 * workers on https or http://localhost, so an RF gun on plain http://<lan-host>
 * simply runs without offline shell caching (the outbox still works).
 */
export function registerServiceWorker(
  nav: Pick<Navigator, "serviceWorker"> | { serviceWorker?: undefined } = navigator,
  enabled: boolean = import.meta.env.PROD,
): void {
  if (!enabled || nav.serviceWorker === undefined) return;
  const register = () => {
    nav.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((error: unknown) => log.warn("service worker registration failed", error));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
