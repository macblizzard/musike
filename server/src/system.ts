import { spawn } from "node:child_process";
import { downloads, ensureEssentials } from "./bootstrap.js";
import { config } from "./config.js";
import { refreshTools, tools } from "./tools.js";
import { HttpError } from "./types.js";
import { clearResolved, holdDuring } from "./ytdlp.js";

export type Channel = "stable" | "nightly";

export interface Job {
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

const RELEASES: Record<Channel, string> = {
  stable: "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
  nightly: "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest",
};

let version: string | null | undefined;
let job: Job | null = null;
const latest = new Map<Channel, { tag: string | null; at: number }>();

/** Runs a command and streams its output lines into `onLine`. Resolves with the exit code. */
function stream(cmd: string, args: string[], onLine: (line: string) => void, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, env: tools().env });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const feed = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n|\r/)
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach(onLine);
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => {
      clearTimeout(timer);
      onLine(err.message);
      resolve(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

async function readVersion(): Promise<string | null> {
  const { ytdlp } = tools();
  if (!ytdlp) return null;
  let out = "";
  const code = await stream(ytdlp, ["--version"], (l) => (out ||= l), 20_000);
  return code === 0 && out ? out : null;
}

async function latestTag(channel: Channel): Promise<string | null> {
  const cached = latest.get(channel);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.tag;
  try {
    const res = await fetch(RELEASES[channel], {
      headers: { "user-agent": "musike", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    const tag = res.ok ? (((await res.json()) as { tag_name?: string }).tag_name ?? null) : null;
    latest.set(channel, { tag, at: Date.now() });
    return tag;
  } catch {
    return cached?.tag ?? null;
  }
}

/** Compares dotted numeric versions like 2026.08.19 and 2026.10.10.232345. */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

export async function systemInfo() {
  const t = tools();
  // Re-read when yt-dlp showed up since the last check (e.g. downloaded on first launch).
  if (version === undefined || (version === null && t.ytdlp)) version = await readVersion();
  const channel: Channel = version && version.split(".").length > 3 ? "nightly" : "stable";
  const [stable, nightly] = await Promise.all([latestTag("stable"), latestTag("nightly")]);
  const target = channel === "nightly" ? nightly : stable;
  return {
    ytdlp: {
      path: t.ytdlp,
      version,
      channel,
      latest: { stable, nightly },
      updateAvailable: !!(version && target && newer(target, version)),
    },
    deno: t.deno,
    ffmpeg: t.ffmpeg,
    canInstall: !!t.winget || !!config.binDir,
    downloads: downloads(),
    job,
  };
}

export function startJob(channel: Channel) {
  if (job?.status === "running") return job;
  const t = tools();
  const kind: Job["kind"] = t.ytdlp ? "update" : "install";
  if (kind === "install" && !t.winget && !config.binDir) {
    throw new HttpError(400, "yt-dlp não encontrado e o winget não está disponível. Instale manualmente: https://github.com/yt-dlp/yt-dlp");
  }

  const current: Job = {
    kind,
    channel,
    status: "running",
    startedAt: Date.now(),
    from: version ?? null,
    to: null,
    message: kind === "install" ? "Instalando yt-dlp" : "Atualizando yt-dlp",
    log: [],
  };
  job = current;
  const log = (line: string) => {
    current.log = [...current.log, line].slice(-40);
  };

  const work = async () => {
    let code: number;
    if (kind === "update") {
      code = await stream(t.ytdlp!, ["--update-to", channel], log, 5 * 60_000);
      // Builds that can't self-update (e.g. installed by a package manager) fall back to winget.
      if (code !== 0 && t.winget) {
        log("Atualização direta falhou, tentando pelo winget");
        code = await stream(t.winget, wingetArgs("upgrade"), log, 10 * 60_000);
      }
    } else if (config.binDir) {
      // Desktop app: download the official builds into Musike's own folder (no admin, no winget).
      log("Baixando yt-dlp e Deno do GitHub");
      code = await ensureEssentials().then(
        () => 0,
        (err: Error) => (log(err.message), 1),
      );
    } else {
      code = await stream(t.winget!, wingetArgs("install"), log, 10 * 60_000);
    }

    await refreshTools();
    version = await readVersion();
    clearResolved();
    current.to = version;
    current.finishedAt = Date.now();
    if (version && (code === 0 || current.from !== version)) {
      current.status = "done";
      current.message =
        current.from === version ? `Já está na versão mais recente (${version})` : `yt-dlp ${version} pronto para uso`;
    } else {
      current.status = "error";
      current.message = current.log.findLast((l) => /error|erro|failed|falha/i.test(l)) ?? "Não foi possível atualizar o yt-dlp.";
    }
  };

  void holdDuring(work().catch((err: Error) => {
    current.status = "error";
    current.finishedAt = Date.now();
    current.message = err.message;
  }));
  return current;
}

const wingetArgs = (verb: "install" | "upgrade") => [
  verb,
  "--id",
  "yt-dlp.yt-dlp",
  "--exact",
  "--silent",
  "--accept-source-agreements",
  "--accept-package-agreements",
  "--disable-interactivity",
];
