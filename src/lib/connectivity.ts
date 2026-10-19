/**
 * Whether we believe the network works. Two inputs:
 *  - the browser's own online/offline flag (airplane mode, Wi-Fi off), and
 *  - whether the last request actually reached the edge (a Wi-Fi bar with no
 *    route -- the common case on a warehouse floor -- still says "online").
 */
type Listener = () => void;

export class Connectivity {
  private browserOnline: boolean;
  private reachable = true;
  private snapshot: boolean;
  private readonly listeners = new Set<Listener>();

  constructor(initialBrowserOnline: boolean = typeof navigator === "undefined" ? true : navigator.onLine) {
    this.browserOnline = initialBrowserOnline;
    this.snapshot = this.browserOnline && this.reachable;
  }

  isOnline(): boolean {
    return this.snapshot;
  }

  /** The browser's own flag only (no knowledge of whether the edge answered). */
  isBrowserOnline(): boolean {
    return this.browserOnline;
  }

  /** A request failed at the network level (no HTTP response at all). */
  reportUnreachable(): void {
    this.reachable = false;
    this.recompute();
  }

  /** Any HTTP response -- even a 4xx problem -- proves the edge is reachable. */
  reportReachable(): void {
    this.reachable = true;
    this.recompute();
  }

  setBrowserOnline(online: boolean): void {
    this.browserOnline = online;
    // A fresh "online" event invites a retry: do not stay pessimistic.
    if (online) this.reachable = true;
    this.recompute();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listen to the window's online/offline events. Returns the unsubscribe. */
  attach(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
    const on = () => this.setBrowserOnline(true);
    const off = () => this.setBrowserOnline(false);
    target.addEventListener("online", on);
    target.addEventListener("offline", off);
    return () => {
      target.removeEventListener("online", on);
      target.removeEventListener("offline", off);
    };
  }

  private recompute(): void {
    const next = this.browserOnline && this.reachable;
    if (next !== this.snapshot) {
      this.snapshot = next;
      for (const l of [...this.listeners]) l();
    }
  }
}
