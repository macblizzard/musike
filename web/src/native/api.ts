import { CapacitorHttp } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { getJob, listModels, startPlaylistJob, testModel, useAiFetch } from "../../../server/src/ai";
import {
  album as albumPage,
  ALBUM_ID,
  artist as artistPage,
  ARTIST_ID,
  GENRE_ID,
  genre as genrePage,
  genreArtists,
  genres,
  searchAlbums,
} from "../../../server/src/browse";
import { msg, tr, type MsgKey } from "../../../server/src/i18n";
import * as library from "../../../server/src/library";
import { findVideoFor, radio, search, suggestions } from "../../../server/src/search";
import { HttpError, VIDEO_ID } from "../../../server/src/types";
import { getLang, getT } from "../i18n";
import { ApiError, type MusikeApi, type SystemInfo } from "../lib/apiTypes";
import "./android";
import { media } from "./media";
import { nativeStorage } from "./storage";
import { forgetUrl, resolveAudio } from "./streams";

// The Android backend: the Musike server's own code (search, genres, artists, albums, library), running on the
// phone instead of behind HTTP. The build swaps lib/api.ts for this module (see vite.config.ts).
export * from "../lib/apiTypes";

library.useLibraryStorage(nativeStorage);

const fail = (status: number, key: MsgKey) => new ApiError(status, tr(getLang(), msg(key)));

/**
 * Providers don't answer `Access-Control-Allow-Origin`, so a webview fetch could never read the reply.
 * Capacitor's native HTTP goes through URLSession instead: no CORS, and the same code as the server.
 */
const nativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  let data: unknown;
  if (typeof init?.body === "string") {
    try {
      data = JSON.parse(init.body);
    } catch {
      data = init.body;
    }
  }
  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    connectTimeout: 30_000,
    readTimeout: 120_000,
  });
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null);
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

useAiFetch(nativeFetch);

/** Runs a server function and turns its errors into what the app expects, in the app's language. */
async function call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const result = await fn();
    // The work can't be cancelled midway, but a caller that gave up must not get the result.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.status, tr(getLang(), e.text), e.code);
    if (e instanceof ApiError || (e as Error).name === "AbortError") throw e;
    throw new ApiError(500, (e as Error).message || getT().player.serverDown);
  }
}

const tracks = (list: unknown[]) => list.slice(0, 500).map(library.sanitizeTrack);

const SYSTEM: SystemInfo = {
  ytdlp: { path: "built-in", version: null, channel: "stable", latest: { stable: null, nightly: null }, updateAvailable: false },
  deno: "built-in",
  ffmpeg: null,
  canInstall: false,
  job: null,
};

export const api: MusikeApi = {
  search: (q, type, signal) =>
    call(async () => {
      if (!q.trim()) throw fail(400, "emptyQuery");
      return search(q.trim().slice(0, 200), type, getLang());
    }, signal),
  suggest: (q, signal) => call(() => suggestions(q.trim().slice(0, 100), getLang()).catch(() => []), signal),
  radio: (id) => call(() => radio(id)),
  genres: () => call(() => genres(getLang())),
  genre: (id, signal) =>
    call(async () => {
      if (!GENRE_ID.test(id)) throw fail(400, "invalidGenre");
      return genrePage(id, getLang());
    }, signal),
  genreArtists: (id, offset) => call(() => genreArtists(id, offset, getLang())),
  artist: (id, signal) =>
    call(async () => {
      if (!ARTIST_ID.test(id)) throw fail(400, "invalidArtist");
      return artistPage(id, getLang());
    }, signal),
  album: (id, signal) =>
    call(async () => {
      if (!ALBUM_ID.test(id)) throw fail(400, "invalidAlbum");
      return albumPage(id, getLang());
    }, signal),
  searchAlbums: (q, signal) => call(() => searchAlbums(q.trim().slice(0, 200), getLang()), signal),
  videoFor: (t) => call(() => findVideoFor(t.id, t.title, t.artist, t.duration)),
  prepare: (id, signal) =>
    call(async () => {
      if (!VIDEO_ID.test(id)) throw fail(400, "invalidVideoId");
      const r = await resolveAudio(id);
      return { id, title: r.title, duration: r.duration, hasSdVideo: false };
    }, signal),

  library: () => call(() => library.getLibrary()),
  addFavorite: (t) => call(async () => ({ favorites: await library.addFavorite(library.sanitizeTrack(t)) })),
  addFavorites: (list) => call(async () => ({ favorites: await library.addFavorites(tracks(list)) })),
  removeFavorite: (id) => call(async () => ({ favorites: await library.removeFavorite(id) })),
  pushHistory: (t) => call(async () => ({ history: await library.pushHistory(library.sanitizeTrack(t)) })),
  createPlaylist: (name, list = []) => call(() => library.createPlaylist(name, tracks(list))),
  renamePlaylist: (id, name) => call(() => library.renamePlaylist(id, name)),
  deletePlaylist: (id) => call(() => library.deletePlaylist(id)),
  addToPlaylist: (id, t) => call(() => library.addToPlaylist(id, Array.isArray(t) ? tracks(t) : library.sanitizeTrack(t))),
  removeFromPlaylist: (id, trackId) => call(() => library.removeFromPlaylist(id, trackId)),
  importLibrary: (backup, mode) =>
    call(async () => {
      const b = (backup ?? {}) as { format?: unknown; version?: unknown; library?: unknown };
      if (b.format !== "musike-backup") throw fail(400, "notBackup");
      if (typeof b.version !== "number" || b.version > 1) throw fail(400, "newerBackup");
      return library.importLibrary(b.library, mode);
    }),

  lyrics: async (t) => {
    // No server on the phone, so lrclib is asked directly. A blocked or offline request is "unknown", not "no
    // lyrics": the sheet then offers a retry instead of claiming the track has none.
    const params = new URLSearchParams({
      track_name: t.title,
      artist_name: t.artist,
      duration: String(Math.round(t.duration || 0)),
    });
    try {
      const res = await fetch(`https://lrclib.net/api/get?${params}`, {
        headers: { "Lrclib-Client": "musike/1.5.1 (self-hosted music player)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 404) return { found: false };
      if (!res.ok) return { found: false, unavailable: true };
      const d = (await res.json()) as {
        instrumental?: boolean;
        plainLyrics?: string;
        syncedLyrics?: string;
        trackName?: string;
        artistName?: string;
        albumName?: string;
      };
      return {
        found: true,
        instrumental: d.instrumental,
        plain: d.plainLyrics,
        synced: d.syncedLyrics,
        track: d.trackName,
        artist: d.artistName,
        album: d.albumName,
        source: "lrclib",
      };
    } catch {
      return { found: false, unavailable: true };
    }
  },

  /** The next audio format for a URL YouTube refused; false once the ladder is spent. */
  retryStream: (url: string) => forgetUrl(url),

  aiModels: (config) => call(() => listModels(config)),
  aiTest: (config) => call(() => testModel(config)),
  aiPlaylist: (request) =>
    call(async () => {
      if (!request.prompt.trim()) throw fail(400, "aiPromptRequired");
      return startPlaylistJob({
        prompt: request.prompt,
        config: request.config,
        personalize: request.personalize,
        count: request.count,
        lang: getLang(),
      });
    }),
  aiJob: (id) => call(async () => getJob(id)),

  system: async () => SYSTEM,
  updateYtdlp: async () => {
    throw new ApiError(400, "yt-dlp isn't used on this device.");
  },
};

/** On the phone, the media element plays YouTube's stream directly: resolved here, no proxy needed. */
export const streamSource = (id: string): Promise<string> => resolveAudio(id).then((r) => r.url);

export async function explainStreamError(url: string): Promise<{ message: string }> {
  forgetUrl(url);
  return { message: navigator.onLine ? getT().player.streamFailed : getT().player.offline };
}

/** Backups are shared through Android's share sheet (save to Files, Drive, send to the computer…). */
export async function saveFile(name: string, text: string) {
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: name, files: [uri] });
}

export const systemMedia = media;

export const capabilities = { video: false, engineSettings: false, retryOnError: true, ai: true };
