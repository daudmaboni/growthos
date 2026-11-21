// Page state that survives switching tabs. Pages unmount when you leave them; anything kept here is
// shown again at once when you come back (and refreshed quietly behind it), instead of the page
// blanking and loading from zero. Lives in memory only: a full reload of the app starts fresh.
import { useCallback, useEffect, useState } from "react";

const vals = new Map<string, unknown>();
const subs = new Map<string, Set<(v: unknown) => void>>();

export const kept = (key: string) => vals.has(key);
export function peek<T>(key: string): T | undefined { return vals.get(key) as T | undefined; }
export function put<T>(key: string, v: T) { vals.set(key, v); subs.get(key)?.forEach((f) => f(v)); }

type Set_<T> = (v: T | ((prev: T) => T)) => void;

/** Like useState, but the value outlives the page. Updates made after the page has closed (an answer
 *  that arrives while you're on another tab) are kept and shown when you return. */
export function useKept<T>(key: string, init: T): [T, Set_<T>] {
  const [v, setV] = useState<T>(() => (vals.has(key) ? (vals.get(key) as T) : init));
  useEffect(() => {
    let s = subs.get(key);
    if (!s) subs.set(key, (s = new Set()));
    const f = (x: unknown) => setV(x as T);
    s.add(f);
    setV(vals.has(key) ? (vals.get(key) as T) : init);
    return () => { s!.delete(f); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback<Set_<T>>((u) => {
    const prev = (vals.has(key) ? vals.get(key) : init) as T;
    put(key, typeof u === "function" ? (u as (p: T) => T)(prev) : u);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [v, set];
}
