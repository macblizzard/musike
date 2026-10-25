import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureComponent } from "./bootstrap.js";
import { config } from "./config.js";
import { DEFAULT_CLIENTS, directAudio, fetchRemoteClients } from "./directAudio.js";
import { tools } from "./tools.js";
import { msg } from "./i18n.js";
import { HttpError } from "./types.js";

export interface StreamFormat {
  formatId: string;
  url: string;
  headers: Record<string, string>;
  mime: string;
}

export interface Resolved {
  id: string;
  title: string;
  duration: number;
  audio: StreamFormat;
  /** Every audio format, best first — lets the proxy retry when one URL is refused. */
  audioAll?: StreamFormat[];
  video?: StreamFormat;
  expiresAt: number;
}

interface RawFormat {
  format_id: string;
  url?: string;
  ext: string;
  acodec?: string;
  vcodec?: string;
  height?: number;
  abr?: number;
  protocol?: string;
  http_headers?: Record<string, string>;
}

const RESOLVE_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

let maintenance: Promise<unknown> | null = null;

/** While yt-dlp is being updated or installed, new runs wait instead of racing the executable swap. */
export function holdDuring<T>(job: Promise<T>): Promise<T> {
  const p = job.finally(() => {
    if (maintenance === p) maintenance = null;
  });
  maintenance = p;
  return p;
}

async function run(args: string[], timeoutMs: number): Promise<string> {
  if (maintenance) await maintenance.catch(() => {});
  const { ytdlp, env } = tools();
  if (!ytdlp) {
    throw new HttpError(503, msg("ytdlpMissing"), "tool_missing");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, [...config.ytdlpExtraArgs, ...args], { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(504, msg("ytdlpTimeout")));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HttpError(503, msg("ytdlpCantRun", { error: err.message }), "tool_missing"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(toHttpError(stderr));
    });
  });
}

// Failures that usually mean YouTube changed and yt-dlp needs an update.
const OUTDATED = /nsig|signature|n challenge|JavaScript runtime|Unable to extract|Failed to extract|player response|Requested format is not available|HTTP Error 403/i;

function toHttpError(stderr: string): HttpError {
  const line = stderr.split("\n").find((l) => l.includes("ERROR")) ?? stderr.trim().split("\n").pop() ?? "";
  if (/confirm you.re not a bot|Sign in to confirm/i.test(line)) {
    return new HttpError(503, msg("botCheck"), "bot_check");
  }
  if (/Video unavailable|video is unavailable|Private video|removed/i.test(line)) {
    return new HttpError(404, msg("videoUnavailable"));
  }
  if (/age-restricted|inappropriate|confirm your age/i.test(line)) {
    return new HttpError(403, msg("ageRestricted"));
  }
  // yt-dlp's own words stay as they are (English); only the advice around them is translated.
  const detail = line.replace(/^ERROR:\s*/, "").slice(0, 240);
  if (!detail) return new HttpError(502, msg("ytdlpFailed"), "maybe_outdated");
  if (OUTDATED.test(stderr)) return new HttpError(502, msg("ytdlpOutdated", { detail }), "maybe_outdated");
  return new HttpError(502, detail, "maybe_outdated");
}

/** Forget resolved stream URLs, e.g. after updating yt-dlp so the next play uses the new version. */
export function clearResolved() {
  resolvedAt.clear();
}

const isAudioOnly = (f: RawFormat) => !!f.url && f.vcodec === "none" && !!f.acodec && f.acodec !== "none";
const isMuxed = (f: RawFormat) => !!f.url && !!f.vcodec && f.vcodec !== "none" && !!f.acodec && f.acodec !== "none";
const isHttps = (f: RawFormat) => !f.protocol || f.protocol === "https";

function toStream(f: RawFormat, kind: "audio" | "video"): StreamFormat {
  const mime = kind === "audio" ? (f.ext === "webm" ? "audio/webm" : "audio/mp4") : "video/mp4";
  return { formatId: f.format_id, url: f.url!, headers: f.http_headers ?? {}, mime };
}

/**
 * Every audio format, best first. YouTube refuses (HTTP 403) individual itags per session —
 * format 140 has been observed blocked while 251 or 139 still played for the same video — so
 * callers need the whole ladder, not a single pick. 140 leads because AAC/MP4 plays everywhere,
 * including iOS Safari; Opus/WebM follows.
 */
const AUDIO_PREFERENCE = ["140", "251", "250", "249", "139"];

export function pickAudioAll(formats: RawFormat[]): RawFormat[] {
  const audio = formats.filter((f) => isAudioOnly(f) && isHttps(f));
  const ranked: RawFormat[] = [];
  for (const want of AUDIO_PREFERENCE) {
    const hit = audio.find((f) => f.format_id === want);
    if (hit) ranked.push(hit);
  }
  const rest = audio.filter((f) => !ranked.includes(f)).sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
  return [...ranked, ...rest];
}

function pickAudio(formats: RawFormat[]): RawFormat | undefined {
  return pickAudioAll(formats)[0];
}

function pickVideo(formats: RawFormat[]): RawFormat | undefined {
  const muxed = formats.filter((f) => isMuxed(f) && isHttps(f) && f.ext === "mp4");
  return muxed.find((f) => f.format_id === "18") ?? muxed.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
}

function expiryOf(url: string): number {
  const expire = Number(new URL(url).searchParams.get("expire"));
  const fallback = Date.now() + 4 * 3600_000;
  // Refresh 10 minutes before googlevideo URLs expire.
  return Number.isFinite(expire) && expire > 0 ? expire * 1000 - 10 * 60_000 : fallback;
}

const cache = new Map<string, Promise<Resolved>>();
const resolvedAt = new Map<string, Resolved>();

// When yt-dlp fails, the clients to ask YouTube directly (see directAudio.ts), refreshed from the repository.
// Read lazily: directAudio.ts and this module import each other through search.ts.
let directClients: string[] | null = null;
let directClientsAt = 0;

async function clientsForDirect(): Promise<string[]> {
  if (Date.now() - directClientsAt > 6 * 3600_000) {
    directClientsAt = Date.now();
    directClients = (await fetchRemoteClients()) ?? directClients;
  }
  return directClients ?? DEFAULT_CLIENTS;
}

/**
 * Plan B for audio: YouTube's bot check stops yt-dlp on some connections (VPNs, shared networks), and a YouTube
 * change can break it until it's updated. Asking YouTube for the audio directly often still works. Video stays
 * yt-dlp's job.
 */
async function resolveDirect(id: string, ytdlpError: unknown): Promise<Resolved> {
  // Removed, private or age-restricted videos won't play any other way either.
  if (ytdlpError instanceof HttpError && (ytdlpError.status === 403 || ytdlpError.status === 404)) throw ytdlpError;
  try {
    const direct = await directAudio(id, await clientsForDirect());
    return {
      id,
      title: direct.title,
      duration: direct.duration,
      audio: { formatId: "direct", url: direct.url, headers: {}, mime: direct.mime },
      expiresAt: direct.expiresAt - 10 * 60_000,
    };
  } catch {
    throw ytdlpError; // yt-dlp's error says more, and may offer the update
  }
}

export function resolveStreams(id: string): Promise<Resolved> {
  const done = resolvedAt.get(id);
  if (done && done.expiresAt > Date.now()) return Promise.resolve(done);
  const inflight = cache.get(id);
  if (inflight) return inflight;

  const job = run(["-J", "--no-playlist", "--no-warnings", `https://www.youtube.com/watch?v=${id}`], RESOLVE_TIMEOUT_MS)
    .then((stdout): Resolved => {
      const info = JSON.parse(stdout) as { title: string; duration?: number; formats: RawFormat[] };
      const audio = pickAudio(info.formats);
      if (!audio) throw new HttpError(404, msg("noAudio"));
      const video = pickVideo(info.formats);
      return {
        id,
        title: info.title,
        duration: info.duration ?? 0,
        audio: toStream(audio, "audio"),
        audioAll: pickAudioAll(info.formats).map((f) => toStream(f, "audio")),
        video: video ? toStream(video, "video") : undefined,
        expiresAt: expiryOf(audio.url!),
      };
    })
    .catch((err) => resolveDirect(id, err))
    .then((resolved) => {
      resolvedAt.set(id, resolved);
      return resolved;
    })
    .finally(() => cache.delete(id));

  cache.set(id, job);
  return job;
}

export function invalidate(id: string) {
  resolvedAt.delete(id);
}

const downloads = new Map<string, Promise<string>>();

/** Keeps the video cache under `config.cacheMaxBytes`, evicting least recently played files first. */
export async function pruneCache(): Promise<void> {
  if (!existsSync(config.cacheDir)) return;
  const names = (await readdir(config.cacheDir)).filter((n) => n.endsWith(".720.mp4"));
  const files = await Promise.all(
    names.map(async (n) => {
      const p = path.join(config.cacheDir, n);
      const s = await stat(p);
      return { p, size: s.size, used: s.mtimeMs };
    }),
  );
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= config.cacheMaxBytes) break;
    await rm(f.p, { force: true });
    total -= f.size;
  }
}

/** Downloads and merges a 720p H.264 + AAC MP4 into the cache, for HD video playback with seeking. */
export function downloadHd(id: string): Promise<string> {
  const file = path.join(config.cacheDir, `${id}.720.mp4`);
  if (existsSync(file)) {
    // Mark as recently used for cache eviction.
    const now = new Date();
    utimes(file, now, now).catch(() => {});
    return Promise.resolve(file);
  }
  const inflight = downloads.get(id);
  if (inflight) return inflight;

  const tmp = path.join(config.cacheDir, `${id}.720.part.mp4`);
  // Merging video + audio needs FFmpeg; the desktop app fetches it on first use if it isn't there yet.
  const job = (tools().ffmpeg || !config.binDir ? Promise.resolve() : ensureComponent("ffmpeg"))
    .then(() => mkdir(config.cacheDir, { recursive: true }))
    .then(() =>
      run(
        [
          "--no-playlist",
          "--no-warnings",
          "--no-part",
          "-N", "4",
          "-f", "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][height<=720]/bv*[height<=720]+ba",
          "--merge-output-format", "mp4",
          "-o", tmp,
          `https://www.youtube.com/watch?v=${id}`,
        ],
        DOWNLOAD_TIMEOUT_MS,
      ),
    )
    .then(async () => {
      await rename(tmp, file);
      pruneCache().catch(() => {});
      return file;
    })
    .catch(async (err) => {
      await rm(tmp, { force: true });
      throw err;
    })
    .finally(() => downloads.delete(id));

  downloads.set(id, job);
  return job;
}

const audioJobs = new Map<string, Promise<string | null>>();

/**
 * A progressive (non-fragmented) copy of a track's audio, remuxed into the cache.
 *
 * YouTube serves format 140 as a fragmented MP4: the `moov` carries no sample table and the
 * timeline lives in `moof` fragments. Browsers rebuild it, but iOS/AVFoundation does not. It
 * mis-reads the duration of such a file, plays the song, and then sits in silence until the
 * wrong duration runs out — which is heard as minutes of blank audio at every track boundary.
 * Stream-copying the audio into a plain progressive MP4 (no re-encode, no quality loss) gives
 * the duration every player agrees on.
 *
 * Returns null when the track should keep streaming as-is: too long to cache, or no FFmpeg.
 */
export function progressiveAudio(id: string): Promise<string | null> {
  const file = path.join(config.cacheDir, `${id}.m4a`);
  if (existsSync(file)) {
    // Mark as recently used for cache eviction.
    const now = new Date();
    utimes(file, now, now).catch(() => {});
    return Promise.resolve(file);
  }
  const inflight = audioJobs.get(id);
  if (inflight) return inflight;

  const tmp = path.join(config.cacheDir, `${id}.part.m4a`);
  const job = (async (): Promise<string | null> => {
    const resolved = await resolveStreams(id);
    if (resolved.duration > config.audioMaxSeconds) return null;
    // Merging/remuxing needs FFmpeg; the desktop app fetches it on first use if it isn't there yet.
    const ffmpeg = tools().ffmpeg ?? (config.binDir ? await ensureComponent("ffmpeg").then(() => tools().ffmpeg) : null);
    if (!ffmpeg) return null;
    await mkdir(config.cacheDir, { recursive: true });
    await downloadAudio(id, tmp);
    await remux(ffmpeg, tmp, file);
    await rm(tmp, { force: true });
    pruneAudioCache().catch(() => {});
    return file;
  })()
    .catch(async (err: unknown) => {
      await rm(tmp, { force: true }).catch(() => {});
      console.warn(`[musike] progressive audio unavailable for ${id}:`, err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => audioJobs.delete(id));

  audioJobs.set(id, job);
  return job;
}

/**
 * Writes the resolved audio to a file at full speed. Walks the AAC ladder (140 -> 139 -> any
 * other m4a) because YouTube refuses individual itags per session, then re-resolves once in case
 * every URL for the track has expired. Only AAC/MP4 is considered: the caller remuxes this into a
 * progressive MP4, and Opus/WebM would not survive that as an iOS-playable file.
 */
async function downloadAudio(id: string, file: string): Promise<void> {
  const candidates = async (): Promise<StreamFormat[]> => {
    const resolved = await resolveStreams(id);
    const ladder = resolved.audioAll ?? [resolved.audio];
    const aac = ladder.filter((c) => c.mime === "audio/mp4");
    return aac.length > 0 ? aac : [resolved.audio];
  };
  // googlevideo throttles a plain full-file GET to roughly 32 KiB/s; a byte range is not.
  const tryFetch = async (candidate: StreamFormat): Promise<boolean> => {
    const res = await fetch(candidate.url, { headers: { ...candidate.headers, Range: "bytes=0-" } });
    if (res.status === 403 || res.status === 410) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok || !res.body) {
      throw new HttpError(502, msg("streamRefused", { status: res.status }), "maybe_outdated");
    }
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    return true;
  };
  for (const candidate of await candidates()) {
    if (await tryFetch(candidate)) return;
  }
  invalidate(id);
  for (const candidate of await candidates()) {
    if (await tryFetch(candidate)) return;
  }
  throw new HttpError(502, msg("streamRefused", { status: 403 }), "maybe_outdated");
}

/** Stream-copies a fragmented MP4 into a progressive one: moov + sample table ahead of the data. */
function remux(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", output],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim().split("\n").pop()?.slice(0, 200) || `ffmpeg exited ${code}`));
    });
  });
}

/** Keeps the progressive-audio cache under `config.audioCacheMaxBytes`, evicting least recently played first. */
export async function pruneAudioCache(): Promise<void> {
  if (!existsSync(config.cacheDir)) return;
  const names = (await readdir(config.cacheDir)).filter((n) => n.endsWith(".m4a") && !n.endsWith(".part.m4a"));
  const files = await Promise.all(
    names.map(async (n) => {
      const p = path.join(config.cacheDir, n);
      const s = await stat(p);
      return { p, size: s.size, used: s.mtimeMs };
    }),
  );
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= config.audioCacheMaxBytes) break;
    await rm(f.p, { force: true });
    total -= f.size;
  }
}

export async function ytdlpSearch(query: string, limit = 20) {
  const stdout = await run(["-J", "--flat-playlist", "--no-warnings", `ytsearch${limit}:${query}`], RESOLVE_TIMEOUT_MS);
  const data = JSON.parse(stdout) as {
    entries: { id: string; title: string; duration?: number; channel?: string; uploader?: string }[];
  };
  return data.entries ?? [];
}
