import { api, streamSource } from "./api";
import type { Track } from "./types";

/**
 * Tracks kept for offline play.
 *
 * Two backends, because the two platforms can do different things:
 *
 * - **In a browser** the whole audio response goes into Cache Storage, keyed on the track id. Playing a kept
 *   track hands the media element a blob URL, so it works with no connection at all — and because the element
 *   gets the entire file at once, seeking never needs a byte-range round trip.
 * - **On the phone** the bytes are downloaded by the native side (`MusikeOffline.swift`) into the app's
 *   Documents folder. It cannot be done here: googlevideo answers without CORS headers, so `fetch()` inside the
 *   web view cannot read the audio (in a browser the request goes to our own server proxy instead), and Documents
 *   survives the cache purges the system makes.
 *
 * The track itself is stored beside its audio, under a `musike:offline:<id>` key, so the Downloaded collection
 * can list what is held without asking the network for anything.
 */
const CACHE = "musike-offline";
const META = "?musike-meta";
const META_KEY = "musike:offline:";

// The cache key deliberately does not depend on the stream URL: the phone resolves its audio per session,
// asynchronously, and the URL expires. `.invalid` is reserved by RFC 2606, so this can never be a real request.
const urlOf = (id: string) => `https://musike.invalid/api/stream/${id}/audio`;
const metaOf = (id: string) => urlOf(id) + META;
const idOf = (url: string) => /\/api\/stream\/([^/]+)\/audio$/.exec(url)?.[1] ?? "";
const isAudio = (k: Request) => !k.url.endsWith(META);

const store = () => caches.open(CACHE);

// ---- The phone's backend (iOS): the native side keeps the files.

interface Bridge {
  postMessage(message: unknown): void;
}

interface NativeReply {
  error?: string;
  path?: string;
  bytes?: number;
  found?: boolean;
  files?: { id: string; bytes: number }[];
}

const bridge = (globalThis as { webkit?: { messageHandlers?: { musikeOffline?: Bridge } } }).webkit?.messageHandlers
  ?.musikeOffline;

const pending = new Map<number, (result: NativeReply) => void>();
let sequence = 0;

(globalThis as { __musikeOffline?: (req: number, result: NativeReply) => void }).__musikeOffline = (req, result) => {
  const done = pending.get(req);
  if (!done) return;
  pending.delete(req);
  done(result);
};

/** One request to the native downloader. Resolves with its reply, or an `error` when it never answers. */
function native(cmd: string, payload: Record<string, unknown> = {}): Promise<NativeReply> {
  return new Promise((resolve) => {
    if (!bridge) {
      resolve({ error: "unavailable" });
      return;
    }
    const req = ++sequence;
    pending.set(req, resolve);
    bridge.postMessage({ cmd, req, ...payload });
    // A track can take a while on a slow connection; a missed answer must not leave the button spinning.
    setTimeout(() => {
      if (pending.delete(req)) resolve({ error: "timeout" });
    }, 240_000);
  });
}

const nativeIds = async (): Promise<string[]> => ((await native("list")).files ?? []).map((f) => f.id);
const metaKey = (id: string) => META_KEY + id;

function keptMeta(): { track: Track; keptAt?: number }[] {
  const rows: { track: Track; keptAt?: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(META_KEY)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as { track?: Track; keptAt?: number } | null;
      if (parsed?.track?.id) rows.push(parsed as { track: Track; keptAt?: number });
    }
  } catch {
    /* storage unavailable: the collection is empty rather than broken */
  }
  return rows;
}

// ---- The public API, whichever backend is behind it.

/** Whether keeping tracks is possible here: the native downloader, or Cache Storage in a secure context. */
export const offlineSupported = () => !!bridge || typeof caches !== "undefined";

/** Every stored track id. */
export async function keptIds(): Promise<Set<string>> {
  if (bridge) return new Set(await nativeIds());
  if (!offlineSupported()) return new Set();
  const keys = (await (await store()).keys()).filter(isAudio);
  return new Set(keys.map((k) => idOf(k.url)).filter(Boolean));
}

/** Stores a track's audio, and the track itself beside it. */
export async function keep(track: Track): Promise<void> {
  if (bridge) {
    let reason = "The download failed.";
    // YouTube refuses individual audio formats per session, so a refused URL is retried with the next one.
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = await streamSource(track.id, "audio", "sd");
      const reply = await native("download", { id: track.id, url });
      if (reply.path) {
        try {
          localStorage.setItem(metaKey(track.id), JSON.stringify({ track, keptAt: Date.now() }));
        } catch {
          /* the audio is kept; only the listing metadata is missing */
        }
        return;
      }
      reason = reply.error ?? reason;
      if (!api.retryStream?.(url)) break;
    }
    throw new Error(reason);
  }

  // Fetched without a Range header, so the whole file is what gets saved.
  const res = await fetch(await streamSource(track.id, "audio", "sd"));
  if (!res.ok) throw new Error(`stream ${res.status}`);
  const c = await store();
  await c.put(urlOf(track.id), res);
  await c.put(
    metaOf(track.id),
    new Response(JSON.stringify({ track, keptAt: Date.now() }), { headers: { "content-type": "application/json" } }),
  );
}

/** The kept tracks, newest first. */
export async function keptTracks(): Promise<Track[]> {
  if (bridge) {
    const held = new Set(await nativeIds());
    return keptMeta()
      .filter((r) => held.has(r.track.id))
      .sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0))
      .map((r) => r.track);
  }
  if (!offlineSupported()) return [];
  const c = await store();
  const keys = (await c.keys()).filter((k) => k.url.endsWith(META));
  const rows = await Promise.all(
    keys.map(async (k) => {
      const res = await c.match(k);
      if (!res) return null;
      try {
        return (await res.json()) as { track?: Track; keptAt?: number };
      } catch {
        return null;
      }
    }),
  );
  return rows
    .filter((r): r is { track: Track; keptAt?: number } => !!r?.track?.id)
    .sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0))
    .map((r) => r.track);
}

export async function drop(id: string): Promise<void> {
  if (bridge) {
    await native("remove", { id });
    try {
      localStorage.removeItem(metaKey(id));
    } catch {
      /* nothing to forget */
    }
    return;
  }
  if (!offlineSupported()) return;
  const c = await store();
  await c.delete(urlOf(id));
  await c.delete(metaOf(id));
}

/** Removes every stored track. */
export async function dropAll(): Promise<void> {
  if (bridge) {
    for (const id of await nativeIds()) await native("remove", { id });
    for (const row of keptMeta()) {
      try {
        localStorage.removeItem(metaKey(row.track.id));
      } catch {
        /* nothing to forget */
      }
    }
    return;
  }
  if (!offlineSupported()) return;
  await caches.delete(CACHE);
}

/**
 * The stored audio for a track, or undefined when it is not kept: a **Blob** in a browser (the caller makes an
 * object URL) and a **local file URL** on the phone, which the native player reads straight off disk.
 */
export async function read(id: string): Promise<Blob | string | undefined> {
  if (bridge) {
    const reply = await native("path", { id });
    return reply.found && reply.path ? `file://${reply.path}` : undefined;
  }
  if (!offlineSupported()) return undefined;
  const res = await (await store()).match(urlOf(id));
  return res ? res.blob() : undefined;
}

/** How much audio is held for offline play, from the stored sizes. */
export async function usage(): Promise<{ bytes: number; count: number }> {
  if (bridge) {
    const files = (await native("list")).files ?? [];
    return { bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0), count: files.length };
  }
  if (!offlineSupported()) return { bytes: 0, count: 0 };
  const c = await store();
  const keys = (await c.keys()).filter(isAudio);
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
