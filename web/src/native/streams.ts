import { Capacitor } from "@capacitor/core";
import { msg, tr } from "../../../server/src/i18n";
import { config } from "./shims/config";
import { nativeResolverAvailable, resolveNatively } from "./ytplayer";

import { text, withClient } from "../../../server/src/search";
import { getLang } from "../i18n";
import { ApiError } from "../lib/apiTypes";

/**
 * Resolves a track's audio on the phone, the job yt-dlp does on the server.
 *
 * YouTube only serves the first megabyte of a stream to most clients unless the request carries a proof-of-origin
 * token. A few clients don't need one; VISIONOS (the Apple Vision Pro app) is the one yt-dlp itself relies on, and
 * its URLs need no deciphering either. When YouTube changes that, the list of clients to try can be updated
 * remotely (mobile/streaming.json in the repository) without shipping a new app.
 */

// iOS asks YouTube from Safari's side of the world: its "IOS" client hands out plain URLs, while VISIONOS now hits
// "Sign in to confirm you're not a bot" there. Android keeps the client yt-dlp itself uses.
const DEFAULT_CLIENTS = Capacitor.getPlatform() === "ios" ? ["IOS", "VISIONOS"] : ["VISIONOS"];
const REMOTE_CONFIG = "https://raw.githubusercontent.com/Ernani1234/musike/main/mobile/streaming.json";
const CLIENTS_KEY = "musike:stream-clients";

interface Resolved {
  url: string;
  mime: string;
  size: number;
  title: string;
  duration: number;
  expiresAt: number;
}

const cache = new Map<string, Resolved>();
const inflight = new Map<string, Promise<Resolved>>();

const validClients = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === "string" && /^[A-Z_]{2,30}$/.test(c)) ? (v as string[]) : null;

function storedClients(): string[] {
  try {
    const stored = validClients(JSON.parse(localStorage.getItem(CLIENTS_KEY) ?? "null")) ?? [];
    // This platform's own clients come first: a list saved by an older build (or another platform) must not hide them.
    return [...new Set([...DEFAULT_CLIENTS, ...stored])];
  } catch {
    return DEFAULT_CLIENTS;
  }
}

let clients = storedClients();

/** Picks up a newer client list in the background; the stored one (or the default) is used meanwhile. */
async function refreshClients() {
  try {
    const res = await fetch(REMOTE_CONFIG, { signal: AbortSignal.timeout(6000) });
    const remote = validClients(((await res.json()) as { clients?: unknown }).clients);
    if (!remote) return;
    const merged = [...new Set([...DEFAULT_CLIENTS, ...remote])];
    clients = merged;
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(merged));
  } catch {
    // offline or no config yet: keep what we have
  }
}
void refreshClients();

async function resolve(id: string): Promise<Resolved> {
  if (nativeResolverAvailable()) {
    try {
      const r = await resolveNatively(id, getLang() === "pt-BR" ? "pt-BR" : "en", config.location);
      if (!r.error && r.url) {
        const expire = Number(new URL(r.url).searchParams.get("expire")) * 1000;
        const resolved: Resolved = {
          url: r.url,
          mime: r.mime || "audio/mp4",
          size: 0,
          title: r.title,
          duration: r.duration,
          expiresAt: expire || Date.now() + 3 * 3600_000,
        };
        cache.set(id, resolved);
        return resolved;
      }
    } catch (e) {
      // fall through to the in-app clients below
    }
  }

  let reason = "";
  for (const client of clients) {
    try {
      const info: any = await withClient((yt) => yt.getBasicInfo(id, { client: client as never }), getLang());
      const status = info.playability_status;
      if (status?.status && status.status !== "OK") {
        reason = text(status.reason) || reason;
        continue;
      }
      const formats: any[] = [...(info.streaming_data?.adaptive_formats ?? []), ...(info.streaming_data?.formats ?? [])].filter(
        (f) => f.has_audio && !f.has_video && typeof f.url === "string",
      );
      // AAC (m4a) first: every Android WebView plays it. Highest bitrate within the same kind.
      const best = formats.sort(
        (a, b) => Number(b.mime_type?.startsWith("audio/mp4")) - Number(a.mime_type?.startsWith("audio/mp4")) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
      )[0];
      if (!best) continue;
      const expire = Number(new URL(best.url).searchParams.get("expire")) * 1000;
      const resolved: Resolved = {
        url: best.url,
        mime: String(best.mime_type ?? "audio/mp4"),
        size: Number(best.content_length ?? 0),
        title: info.basic_info?.title ?? "",
        duration: info.basic_info?.duration ?? 0,
        expiresAt: expire || Date.now() + 3 * 3600_000,
      };
      cache.set(id, resolved);
      return resolved;
    } catch (e) {
      reason = (e as Error).message || reason;
    }
  }
  throw new ApiError(404, reason || tr(getLang(), msg("noAudio")));
}

/** A track's stream, from cache while its URL is still good for a minute or more. */
export function resolveAudio(id: string): Promise<Resolved> {
  const hit = cache.get(id);
  if (hit && hit.expiresAt - Date.now() > 60_000) return Promise.resolve(hit);
  let job = inflight.get(id);
  if (!job) {
    job = resolve(id).finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  return job;
}

/** Forgets the stream behind a URL that stopped working, so the next try resolves a fresh one. */
export function forgetUrl(url: string) {
  for (const [id, r] of cache) if (r.url === url) cache.delete(id);
}
