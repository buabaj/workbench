import { ipc } from "../ipc/client";

/**
 * The workspace's file list, kept warm.
 *
 * The palette used to fetch this every time it opened, so ⌘P showed an empty
 * list and then filled in. Rust caches the walk, so the wait was never the
 * disk — it was a round trip and a re-render standing between the keystroke
 * and the thing you were looking for. Small, and the whole difference between
 * a picker that feels instant and one that feels fetched.
 *
 * Module-level rather than a store: nothing re-renders on it, it is read once
 * per open, and a subscription would cost more than it saves.
 */

const cache = new Map<string, string[]>();

/**
 * Workspaces whose files have changed since the index was taken.
 *
 * A stale list is worse than a slow one — a file you just created not being
 * offered reads as broken — so a rewalk is forced when something moved, and
 * skipped entirely when nothing has.
 */
const stale = new Set<string>();

/** What is known right now, for a first paint with no await. */
export function cachedIndex(workspaceId: string | undefined): string[] {
  return (workspaceId && cache.get(workspaceId)) || [];
}

/**
 * The current list, refreshing only when it might have changed.
 *
 * Returns immediately from cache when the index is known to be current, so an
 * ordinary ⌘P costs nothing at all.
 */
export async function loadIndex(workspaceId: string): Promise<string[]> {
  const known = cache.get(workspaceId);
  if (known && !stale.has(workspaceId)) return known;
  try {
    const files = await ipc.workspaceIndex(workspaceId, stale.has(workspaceId));
    cache.set(workspaceId, files);
    stale.delete(workspaceId);
    return files;
  } catch {
    // Whatever is held beats nothing: a stale list still finds the file you
    // are almost certainly looking for.
    return known ?? [];
  }
}

/** Take the index now, so the first ⌘P is already warm. */
export function primeIndex(workspaceId: string): void {
  void loadIndex(workspaceId);
}

/** Something on disk moved; the next read rewalks. */
export function markStale(workspaceId: string): void {
  stale.add(workspaceId);
}

/** Forget a workspace entirely — its paths mean nothing once it is closed. */
export function forgetIndex(workspaceId: string): void {
  cache.delete(workspaceId);
  stale.delete(workspaceId);
}
