import type { Library, Playlist, Track } from "./types";

export type ErrorCode = "tool_missing" | "maybe_outdated" | "bot_check";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: ErrorCode) {
    super(message);
  }
}

export type Channel = "stable" | "nightly";

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
}

export interface SystemJob {
  kind: "update" | "install";
  channel: Channel;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  from: string | null;
  to: string | null;
  message: string;
  log: string[];
}

export interface SystemInfo {
  ytdlp: {
    path: string | null;
    version: string | null;
    channel: Channel;
    latest: Record<Channel, string | null>;
    updateAvailable: boolean;
  };
  deno: string | null;
  ffmpeg: string | null;
  canInstall: boolean;
  job: SystemJob | null;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Erro ${res.status}`, body.code);
  return body as T;
}

export const api = {
  search: (q: string, type: "song" | "video", signal?: AbortSignal) =>
    request<{ tracks: Track[] }>(`/api/search?q=${encodeURIComponent(q)}&type=${type}`, { signal }).then((r) => r.tracks),
  suggest: (q: string, signal?: AbortSignal) =>
    request<{ suggestions: string[] }>(`/api/suggest?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.suggestions),
  radio: (id: string) => request<{ tracks: Track[] }>(`/api/radio/${id}`).then((r) => r.tracks),
  /** The music video matching a song, or null when YouTube has none. */
  videoFor: (t: Track) =>
    request<{ track: Track | null }>(
      `/api/video-for/${t.id}?${new URLSearchParams({ title: t.title, artist: t.artist, duration: String(t.duration || "") })}`,
    ).then((r) => r.track),
  prepare: (id: string, signal?: AbortSignal) =>
    request<{ id: string; title: string; duration: number; hasSdVideo: boolean }>(`/api/prepare/${id}`, {
      method: "POST",
      signal,
    }),

  library: () => request<Library>("/api/library"),
  addFavorite: (t: Track) => request<{ favorites: Track[] }>(`/api/favorites/${t.id}`, { method: "PUT", json: t }),
  removeFavorite: (id: string) => request<{ favorites: Track[] }>(`/api/favorites/${id}`, { method: "DELETE" }),
  pushHistory: (t: Track) => request<{ history: Track[] }>("/api/history", { method: "POST", json: t }),
  createPlaylist: (name: string, tracks: Track[] = []) =>
    request<Playlist>("/api/playlists", { method: "POST", json: { name, tracks } }),
  renamePlaylist: (id: string, name: string) => request<Playlist>(`/api/playlists/${id}`, { method: "PATCH", json: { name } }),
  deletePlaylist: (id: string) => request<void>(`/api/playlists/${id}`, { method: "DELETE" }),
  addToPlaylist: (id: string, t: Track) => request<Playlist>(`/api/playlists/${id}/tracks`, { method: "POST", json: t }),
  removeFromPlaylist: (id: string, trackId: string) =>
    request<Playlist>(`/api/playlists/${id}/tracks/${trackId}`, { method: "DELETE" }),

  importLibrary: (backup: unknown, mode: "merge" | "replace") =>
    request<ImportResult>("/api/library/import", { method: "POST", json: { backup, mode } }),

  system: () => request<SystemInfo>("/api/system"),
  updateYtdlp: (channel: Channel) => request<SystemJob>("/api/system/ytdlp", { method: "POST", json: { channel } }),
};

export const streamUrl = (id: string, kind: "audio" | "video", quality: "sd" | "hd") =>
  kind === "audio" ? `/api/stream/${id}/audio` : `/api/stream/${id}/video?q=${quality}`;

/** Media elements hide the HTTP error body; fetch it to show the real reason. */
export async function explainStreamError(url: string): Promise<{ message: string; code?: ErrorCode }> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (res.ok) return { message: "O navegador não conseguiu reproduzir este formato." };
    const body = await res.json().catch(() => ({}));
    return { message: body.error ?? `Erro ${res.status}`, code: body.code };
  } catch {
    return { message: "Servidor do Musike inacessível. Ele está rodando?" };
  }
}
