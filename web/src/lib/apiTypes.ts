import type { AlbumCard, AlbumPage, ArtistPage, Genre, GenreArtist, GenrePage, Library, Playlist, Track } from "./types";

/**
 * What the app needs from a backend. The web app and the desktop app talk to the Musike server over HTTP
 * (lib/api.ts); the Android app does the same work on the phone (native/api.ts). The build picks one.
 */

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

/**
 * Where the AI playlist assistant talks to: an OpenAI-compatible endpoint the person configures on the
 * device. The key is only ever stored here, in the app's own storage, and travels with each request.
 */
export interface AiProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiPlaylistRequest {
  prompt: string;
  config: AiProviderConfig;
  /** Send a digest of favorites and history so the playlist fits what the person already listens to. */
  personalize: boolean;
  count?: number;
}

/** What the assistant is doing right now, for the progress line. */
export type AiJobStage = "thinking" | "searching" | "creating";

export interface AiJob {
  id: string;
  status: "running" | "done" | "error";
  stage: AiJobStage;
  detail: string;
  startedAt: number;
  finishedAt?: number;
  playlist?: Playlist;
  error?: string;
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

export interface Prepared {
  id: string;
  title: string;
  duration: number;
  hasSdVideo: boolean;
}

/**
 * The operating system's media controls (notification, lock screen, headphone buttons) when the browser's
 * Media Session can't reach them: the Android app. Absent elsewhere.
 */
export interface SystemMedia {
  setTrack(track: { title: string; artist: string; album: string; artwork: string }): void;
  setState(state: { playing: boolean; position: number; duration: number }): void;
  onAction(handler: (action: "play" | "pause" | "next" | "previous" | "seek", position?: number) => void): void;
}

/**
 * Lyrics for a track, from lrclib. The server keeps the answer, so each track is looked up once.
 */
export interface Lyrics {
  found: boolean;
  /** lrclib was unreachable or busy, so there is no answer yet — offer a retry. */
  unavailable?: boolean;
  instrumental?: boolean;
  plain?: string;
  synced?: string;
  track?: string;
  artist?: string;
  album?: string;
  source?: string;
}

export interface MusikeApi {
  search(q: string, type: "song" | "video", signal?: AbortSignal): Promise<Track[]>;
  suggest(q: string, signal?: AbortSignal): Promise<string[]>;
  radio(id: string): Promise<Track[]>;
  genres(): Promise<Genre[]>;
  genre(id: string, signal?: AbortSignal): Promise<GenrePage>;
  genreArtists(id: string, offset: number): Promise<{ artists: GenreArtist[]; hasMore: boolean }>;
  artist(id: string, signal?: AbortSignal): Promise<ArtistPage>;
  album(id: string, signal?: AbortSignal): Promise<AlbumPage>;
  searchAlbums(q: string, signal?: AbortSignal): Promise<AlbumCard[]>;
  /** The music video matching a song, or null when YouTube has none. */
  videoFor(t: Track): Promise<Track | null>;
  prepare(id: string, signal?: AbortSignal): Promise<Prepared>;

  library(): Promise<Library>;
  addFavorite(t: Track): Promise<{ favorites: Track[] }>;
  addFavorites(tracks: Track[]): Promise<{ favorites: Track[] }>;
  removeFavorite(id: string): Promise<{ favorites: Track[] }>;
  pushHistory(t: Track): Promise<{ history: Track[] }>;
  createPlaylist(name: string, tracks?: Track[]): Promise<Playlist>;
  renamePlaylist(id: string, name: string): Promise<Playlist>;
  deletePlaylist(id: string): Promise<void>;
  addToPlaylist(id: string, t: Track | Track[]): Promise<Playlist>;
  removeFromPlaylist(id: string, trackId: string): Promise<Playlist>;
  importLibrary(backup: unknown, mode: "merge" | "replace"): Promise<ImportResult>;

  /** Lyrics from lrclib. The server keeps the answer, so each track is looked up once. */
  lyrics(t: Track): Promise<Lyrics>;
  /**
   * Backends that resolve a stream themselves (the phone) can offer the next audio format when YouTube refuses
   * the current one. True while another format is left. The browser proxy has no equivalent: it retries server-side.
   */
  retryStream?(url: string): boolean;

  system(): Promise<SystemInfo>;
  updateYtdlp(channel: Channel): Promise<SystemJob>;

  /**
   * The AI playlist assistant. Optional: a backend without it (the Android build) simply doesn't offer the
   * feature, and the app hides it. The web/desktop backend proxies the call so the key never sits on the server.
   */
  aiModels?(config: AiProviderConfig): Promise<string[]>;
  aiTest?(config: AiProviderConfig): Promise<{ reply: string }>;
  aiPlaylist?(request: AiPlaylistRequest): Promise<{ jobId: string }>;
  aiJob?(id: string): Promise<AiJob>;
}
