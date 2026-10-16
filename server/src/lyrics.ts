import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * Lyrics for a track, looked up at lrclib.net — a free, community lyrics database with no key,
 * no account and no quota.
 *
 * Every answer is kept in `data/lyrics.json`, misses included, so a track is asked about exactly
 * once and the app works the same when lrclib is unreachable. A miss is re-checked after a month:
 * the database keeps growing.
 */
export interface Lyrics {
  /** False once lrclib has been asked and had nothing. */
  found: boolean;
  /** True when lrclib could not be reached or was busy, so the answer is unknown rather than empty. */
  unavailable?: boolean;
  instrumental?: boolean;
  /** Untimed words. */
  plain?: string;
  /** LRC, `[mm:ss.xx] line`, when lrclib has the timing. */
  synced?: string;
  track?: string;
  artist?: string;
  album?: string;
  source?: string;
  /** When the answer was stored, so a miss can be retried later. */
  at: number;
}

interface Row {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

const FILE = path.join(config.dataDir, "lyrics.json");
const ENDPOINT = "https://lrclib.net/api";
const TIMEOUT_MS = 8000;
const RECHECK_MISS_MS = 30 * 24 * 3600_000;
/** lrclib asks callers to identify themselves. */
const UA = "musike/1.2 (self-hosted music player)";

let store: Map<string, Lyrics> | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function open(): Promise<Map<string, Lyrics>> {
  if (store) return store;
  try {
    store = new Map(Object.entries(JSON.parse(await readFile(FILE, "utf8")) as Record<string, Lyrics>));
  } catch {
    store = new Map();
  }
  return store;
}

function persist(): void {
  const snapshot = JSON.stringify(Object.fromEntries(store ?? []));
  writeChain = writeChain
    .then(async () => {
      await mkdir(config.dataDir, { recursive: true });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, FILE);
    })
    .catch(() => {
      /* a cache write is never worth failing a request over */
    });
}

/** What an uploader wraps around a song title: promo brackets, "// with X", "| Album", "Official Video". */
function cleanTitle(title: string): string {
  return title
    .replace(/[([][^)\]]*\b(official|lyric|audio|video|hd|hq|4k|remaster(?:ed)?|live|mv|m\/v)[^)\]]*[)\]]/gi, " ")
    .replace(/\s*\/\/.*$/, " ")
    .replace(/\s*[|•].*$/, " ")
    .replace(/\b(official|lyrics?|audio|video|hd|remaster(?:ed)?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
    .trim();
}

/** Channel names that stand in for the artist: "SCHILLER official", "Kayahin - Topic", "…VEVO". */
function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*[-–]\s*topic$/i, "")
    .replace(/\s*(official|vevo|records|music)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A definitive answer from lrclib: a body, or a 404 meaning "nothing here" — as opposed to an outage. */
interface Answer {
  /** lrclib answered the question — a body, or "no such track". */
  ok: boolean;
  /** Busy (503/429): worth another try in a moment, and not worth remembering. */
  busy?: boolean;
  data?: unknown;
  retryAfterMs?: number;
}

async function attempt(url: string): Promise<Answer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: abort.signal });
    if (res.status === 404) return { ok: true };
    if (res.status === 503 || res.status === 429) {
      const after = Number(res.headers.get("retry-after") ?? 0) * 1000;
      return { ok: false, busy: true, retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after, 2500) : 900 };
    }
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** lrclib is a free service and often answers 503 with a retry-after; one retry turns most of those into answers. */
async function ask(url: string): Promise<Answer> {
  const first = await attempt(url);
  if (first.ok || !first.busy) return first;
  await new Promise((r) => setTimeout(r, first.retryAfterMs ?? 900));
  return attempt(url);
}

function toLyrics(row: Row | undefined): Lyrics | null {
  if (!row || typeof row !== "object") return null;
  const plain = typeof row.plainLyrics === "string" && row.plainLyrics.trim() ? row.plainLyrics.trim() : undefined;
  const synced = typeof row.syncedLyrics === "string" && row.syncedLyrics.trim() ? row.syncedLyrics.trim() : undefined;
  if (!plain && !synced) return null;
  return {
    found: true,
    plain,
    synced,
    instrumental: !!row.instrumental,
    track: row.trackName,
    artist: row.artistName,
    album: row.albumName,
    source: "lrclib",
    at: Date.now(),
  };
}

/** Timed lyrics beat untimed ones, and a duration within a few seconds beats a different version. */
function pick(rows: Row[], duration: number): Row | undefined {
  const usable = rows.filter((r) => r && (r.plainLyrics || r.syncedLyrics));
  const near = duration ? usable.filter((r) => Math.abs((r.duration ?? 0) - duration) <= 5) : [];
  return near.find((r) => r.syncedLyrics) ?? near[0] ?? usable.find((r) => r.syncedLyrics) ?? usable[0];
}

export async function lyricsFor(id: string, track: { title?: string; artist?: string; duration?: number }): Promise<Lyrics> {
  const cache = await open();
  const known = cache.get(id);
  if (known && (known.found || Date.now() - known.at < RECHECK_MISS_MS)) return known;

  const title = cleanTitle(track.title ?? "");
  const artist = cleanArtist(track.artist ?? "");
  const duration = Math.max(0, Math.round(track.duration ?? 0));
  let result: Lyrics = { found: false, unavailable: false, at: Date.now() };
  /** True once the whole question has been answered, either way. */
  let answered = false;

  if (title) {
    // The exact lookup first — lrclib scores it strictly, so it either matches this version or nothing.
    const exact = new URLSearchParams({ track_name: title, artist_name: artist });
    if (duration) exact.set("duration", String(duration));
    const got = await ask(`${ENDPOINT}/get?${exact}`);
    if (!got.ok) {
      // Could not ask at all: unknown rather than empty, and nothing to remember.
      result.unavailable = true;
      return result;
    }
    const hit = toLyrics(got.data as Row | undefined);
    if (hit) {
      result = hit;
      answered = true;
    } else {
      // No such exact match: search instead, which also catches uploaders that split the artist differently.
      const found = await ask(`${ENDPOINT}/search?${new URLSearchParams({ q: `${artist} ${title}`.trim() })}`);
      if (!found.ok || !Array.isArray(found.data)) {
        result.unavailable = true;
        return result;
      }
      const best = toLyrics(pick(found.data as Row[], duration));
      if (best) result = best;
      answered = true;
    }
  }

  // Remember a real answer, a miss included, so a track is asked about once. An outage, or a busy
  // lrclib, is not an answer and must not be remembered as "no lyrics".
  if (answered) {
    cache.set(id, result);
    persist();
  }
  return result;
}
