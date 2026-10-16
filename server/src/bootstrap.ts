import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { config } from "./config.js";
import { refreshTools, tools } from "./tools.js";
import { msg, tr, type Lang, type Text } from "./i18n.js";
import { HttpError } from "./types.js";

const exec = promisify(execFile);

export type Component = "yt-dlp" | "deno" | "ffmpeg";

export interface DownloadState {
  received: number;
  total: number;
  status: "downloading" | "extracting" | "done" | "error";
  error?: Text;
}

/** Official Windows builds. FFmpeg is the LGPL "shared" build: about half the size of the static one. */
const SOURCES: Record<Component, string> = {
  "yt-dlp": "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
  deno: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
  ffmpeg: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip",
};

const states = new Map<Component, DownloadState>();
const inflight = new Map<Component, Promise<void>>();

/** Download progress, with errors in `lang`. */
export const downloads = (lang: Lang = "en"): Partial<Record<Component, Omit<DownloadState, "error"> & { error?: string }>> =>
  Object.fromEntries([...states].map(([c, s]) => [c, { ...s, error: s.error === undefined ? undefined : tr(lang, s.error) }]));

const isInstalled = (c: Component) => !!(c === "yt-dlp" ? tools().ytdlp : c === "deno" ? tools().deno : tools().ffmpeg);

/** Downloads one tool into the app's private bin folder (no-op if already available anywhere). */
export function ensureComponent(c: Component): Promise<void> {
  if (isInstalled(c)) return Promise.resolve();
  const bin = config.binDir;
  if (!bin) return Promise.reject(new HttpError(503, msg("toolMissing", { tool: c }), "tool_missing"));
  const running = inflight.get(c);
  if (running) return running;

  const state: DownloadState = { received: 0, total: 0, status: "downloading" };
  states.set(c, state);

  const job = (async () => {
    await mkdir(bin, { recursive: true });
    const tmp = path.join(bin, `.${c}.download`);
    const res = await fetch(SOURCES[c], { headers: { "user-agent": "musike" }, redirect: "follow" });
    if (!res.ok || !res.body) throw new HttpError(502, msg("downloadFailed", { tool: c, status: res.status }));
    state.total = Number(res.headers.get("content-length")) || 0;

    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        state.received += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(tmp));

    if (c === "yt-dlp") {
      await rename(tmp, path.join(bin, "yt-dlp.exe"));
    } else {
      state.status = "extracting";
      const out = path.join(bin, `.${c}-extract`);
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      // Windows 10+ ships bsdtar, which reads zip files.
      const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      await exec(existsSync(tar) ? tar : "tar", ["-xf", tmp, "-C", out], { windowsHide: true });
      if (c === "deno") {
        await rename(path.join(out, "deno.exe"), path.join(bin, "deno.exe"));
      } else {
        // ffmpeg-<build>/bin holds ffmpeg.exe, ffprobe.exe and the DLLs they need.
        const root = (await readdir(out)).find((d) => d.startsWith("ffmpeg"));
        if (!root) throw new HttpError(502, msg("ffmpegPackage"));
        const target = path.join(bin, "ffmpeg");
        await rm(target, { recursive: true, force: true });
        await cp(path.join(out, root, "bin"), target, { recursive: true });
      }
      await rm(out, { recursive: true, force: true });
      await rm(tmp, { force: true });
    }

    await refreshTools();
    state.status = "done";
  })()
    .catch((err: Error) => {
      state.status = "error";
      state.error = err instanceof HttpError ? err.text : err.message;
      throw err;
    })
    .finally(() => inflight.delete(c));

  inflight.set(c, job);
  return job;
}

/** What playback needs: yt-dlp and Deno. FFmpeg (HD and some videos) can follow in the background. */
export async function ensureEssentials(): Promise<void> {
  await Promise.all([ensureComponent("yt-dlp"), ensureComponent("deno")]);
}
