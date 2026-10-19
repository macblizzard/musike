import { DEFAULT_CLIENTS, directAudio, fetchRemoteClients, validClients, type DirectAudio } from "../../../server/src/directAudio";
import { msg, tr } from "../../../server/src/i18n";
import { getLang } from "../i18n";
import { ApiError } from "../lib/apiTypes";

/**
 * Resolves a track's audio on the phone, the job yt-dlp does on the server: straight from YouTube's API
 * (server/src/directAudio.ts). The list of clients to ask can be updated remotely; the last one received is kept.
 */

const CLIENTS_KEY = "musike:stream-clients";

const cache = new Map<string, DirectAudio>();
const inflight = new Map<string, Promise<DirectAudio>>();

function storedClients(): string[] {
  try {
    return validClients(JSON.parse(localStorage.getItem(CLIENTS_KEY) ?? "null")) ?? DEFAULT_CLIENTS;
  } catch {
    return DEFAULT_CLIENTS;
  }
}

let clients = storedClients();

// Pick up a newer client list in the background; the stored one (or the default) is used meanwhile.
void fetchRemoteClients().then((remote) => {
  if (!remote) return;
  clients = remote;
  try {
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(remote));
  } catch {
    /* storage unavailable: keep it for this session */
  }
});

async function resolve(id: string): Promise<DirectAudio> {
  try {
    const resolved = await directAudio(id, clients, getLang());
    cache.set(id, resolved);
    return resolved;
  } catch (e) {
    throw new ApiError(404, (e as Error).message || tr(getLang(), msg("noAudio")));
  }
}

/** A track's stream, from cache while its URL is still good for a minute or more. */
export function resolveAudio(id: string): Promise<DirectAudio> {
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
