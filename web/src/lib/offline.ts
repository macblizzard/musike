import { streamUrl } from "./api";

/**
 * Tracks kept for offline play.
 *
 * The whole audio response is stored in Cache Storage under the same URL the player streams from.
 * Playing a kept track hands the media element a blob URL instead of a network request, so it
 * works with no connection at all — and because the element gets the entire file at once, seeking
 * never needs a byte-range round trip. Storage survives reloads and PWA restarts.
 */
const CACHE = "musike-offline";

const urlOf = (id: string) => streamUrl(id, "audio", "sd");
const idOf = (url: string) => /\/api\/stream\/([^/]+)\/audio$/.exec(url)?.[1] ?? "";

const store = () => caches.open(CACHE);

/** Cache Storage is unavailable in insecure contexts (and some embedded webviews). */
export const offlineSupported = () => typeof caches !== "undefined";

/** Every stored track id. */
export async function keptIds(): Promise<Set<string>> {
  if (!offlineSupported()) return new Set();
  const keys = await (await store()).keys();
  return new Set(keys.map((k) => idOf(k.url)).filter(Boolean));
}

/** Stores a track's audio. Fetched without a Range header, so the whole file is what gets saved. */
export async function keep(id: string): Promise<void> {
  const res = await fetch(urlOf(id));
  if (!res.ok) throw new Error(`stream ${res.status}`);
  await (await store()).put(urlOf(id), res);
}

export async function drop(id: string): Promise<void> {
  if (!offlineSupported()) return;
  await (await store()).delete(urlOf(id));
}

/** Removes every stored track. */
export async function dropAll(): Promise<void> {
  if (!offlineSupported()) return;
  await caches.delete(CACHE);
}

/** The stored audio for a track, or undefined when it is not kept. */
export async function read(id: string): Promise<Blob | undefined> {
  if (!offlineSupported()) return undefined;
  const res = await (await store()).match(urlOf(id));
  return res ? res.blob() : undefined;
}

/** How much is held for offline play, from the stored Content-Lengths. */
export async function usage(): Promise<{ bytes: number; count: number }> {
  if (!offlineSupported()) return { bytes: 0, count: 0 };
  const c = await store();
  const keys = await c.keys();
  let bytes = 0;
  for (const k of keys) {
    const res = await c.match(k);
    bytes += Number(res?.headers.get("content-length") ?? 0);
  }
  return { bytes, count: keys.length };
}

/** YouTube's audio runs about 128 kbps, so a minute is roughly a megabyte — enough to size a download. */
export const approxBytes = (seconds: number) => Math.round((seconds || 0) * 16000);

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
