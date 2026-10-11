// Browser-side API client. The token lives in memory (and this tab's sessionStorage, so a
// reload keeps working); it is sent only in the Authorization header, never in a URL.
import { useEffect, useRef, useState } from "preact/hooks";
import { parseHashToken } from "./format.ts";

const STORAGE_KEY = "signalbox.token";

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
  }
}

/** Takes the token from `#token=…`, strips it from the address bar, and remembers it for this tab. */
export function takeToken(): string | undefined {
  const fromHash = parseHashToken(location.hash);
  if (fromHash) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch {
      // Storage can be unavailable (private mode); the in-memory token still works.
    }
    return fromHash;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function getJson<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface PollState<T> {
  data?: T;
  error?: unknown;
  /** Epoch ms of the last successful fetch. */
  updatedAt?: number;
  /** True while a fetch for the current key is in flight. */
  loading: boolean;
}

/**
 * Fetches `path` now and then every `intervalMs` while the tab is visible. A new path keeps the previous data
 * (so charts hold their frame while refetching) and fetches immediately.
 */
export function usePoll<T>(path: string, token: string, intervalMs: number): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ loading: true });
  const seq = useRef(0);

  useEffect(() => {
    let ctrl: AbortController | undefined;
    let disposed = false;

    async function run(force = false) {
      if (disposed || (!force && document.hidden)) return;
      ctrl?.abort();
      ctrl = new AbortController();
      const mine = ++seq.current;
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await getJson<T>(path, token, ctrl.signal);
        if (disposed || mine !== seq.current) return;
        setState({ data, updatedAt: Date.now(), loading: false });
      } catch (error) {
        if (disposed || mine !== seq.current) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState((s) => ({ ...s, error, loading: false }));
      }
    }

    // Always load once, even in a background tab; only the periodic refresh pauses while hidden.
    run(true);
    const timer = setInterval(() => run(), intervalMs);
    const onVisible = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      ctrl?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, token, intervalMs]);

  return state;
}

/** Re-renders every `ms` so relative times ("40s ago", countdowns) stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
