import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { msg } from "./i18n.js";
import { HttpError } from "./types.js";
import { invalidate, resolveStreams, type StreamFormat } from "./ytdlp.js";

const PASS_HEADERS = ["content-length", "content-range", "accept-ranges", "last-modified"];

/**
 * googlevideo throttles a plain full-file GET to roughly 32 KiB/s — a four-minute song then
 * takes four minutes to arrive. The same file over any byte range comes back at line speed,
 * so a request without a Range header is turned into `bytes=0-` for upstream.
 */
const FULL_RANGE = "bytes=0-";

/**
 * Proxies a googlevideo stream, forwarding Range so the browser can seek natively.
 * googlevideo URLs are bound to the IP that resolved them, so the bytes must flow through this server.
 */
export async function proxyStream(req: FastifyRequest, reply: FastifyReply, id: string, kind: "audio" | "video") {
  const pick = async (fresh: boolean): Promise<StreamFormat> => {
    if (fresh) invalidate(id);
    const resolved = await resolveStreams(id);
    const fmt = kind === "audio" ? resolved.audio : resolved.video;
    if (!fmt) throw new HttpError(404, msg("noSdVideo"));
    return fmt;
  };

  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });

  const request = async (fmt: StreamFormat, range: string) => {
    const headers: Record<string, string> = { ...fmt.headers, Range: range };
    return fetch(fmt.url, { headers, signal: controller.signal });
  };

  // Multi-range requests ("a-b,c-d") come back from googlevideo as multipart/byteranges, which
  // cannot be passed off as a single media file; serve the first range alone instead.
  const rawRange = typeof req.headers.range === "string" ? req.headers.range : null;
  const clientRange = rawRange ? rawRange.split(",")[0].trim() : null;

  let fmt = await pick(false);
  // "bytes=-N" (the tail) is answered with 416 by googlevideo; read the size and ask exactly.
  const suffix = /^bytes=-(\d*)$/.exec(clientRange ?? "");
  let forward = clientRange ?? FULL_RANGE;
  let upstream = await request(fmt, forward);

  if (suffix && upstream.status === 416) {
    await upstream.body?.cancel();
    const total = await contentSize(fmt);
    const want = suffix[1] ? Math.min(Number(suffix[1]), total) : total;
    forward = `bytes=${total - want}-${total - 1}`;
    upstream = await request(fmt, forward);
  }
  // Expired or rejected URL: resolve again once.
  if (upstream.status === 403 || upstream.status === 410) {
    await upstream.body?.cancel();
    fmt = await pick(true);
    upstream = await request(fmt, forward);
  }
  if (!upstream.ok || !upstream.body) {
    throw new HttpError(502, msg("streamRefused", { status: upstream.status }), "maybe_outdated");
  }

  // Upstream was always asked for a range; a client that wanted the whole file still gets a 200.
  const partial = clientRange !== null;
  reply.code(partial ? upstream.status : 200);
  reply.header("content-type", fmt.mime);
  reply.header("cache-control", "no-store");
  for (const h of PASS_HEADERS) {
    if (h === "content-range" && !partial) continue;
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!upstream.headers.get("accept-ranges")) reply.header("accept-ranges", "bytes");

  const body = Readable.fromWeb(upstream.body as any);
  body.on("error", () => body.destroy());
  return reply.send(body);
}

/** Total size of a stream, taken from the Content-Range of a two-byte range request. */
async function contentSize(fmt: StreamFormat): Promise<number> {
  const res = await fetch(fmt.url, { headers: { ...fmt.headers, Range: "bytes=0-1" } });
  const total = Number(/bytes \d+-\d+\/(\d+)/.exec(res.headers.get("content-range") ?? "")?.[1]);
  await res.body?.cancel();
  if (!Number.isFinite(total) || total <= 0) {
    throw new HttpError(502, msg("streamRefused", { status: res.status }), "maybe_outdated");
  }
  return total;
}

/** Serves a local file with byte-range support (used for cached HD video). */
export async function serveFile(req: FastifyRequest, reply: FastifyReply, file: string, mime: string) {
  const { size } = await stat(file);
  const range = typeof req.headers.range === "string" ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;

  reply.header("content-type", mime);
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "no-store");

  if (!range) {
    reply.header("content-length", size);
    return reply.send(createReadStream(file));
  }

  let start = range[1] ? Number(range[1]) : NaN;
  let end = range[2] ? Number(range[2]) : size - 1;
  if (Number.isNaN(start)) {
    // suffix range: bytes=-N
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    reply.code(416).header("content-range", `bytes */${size}`);
    return reply.send();
  }

  reply.code(206);
  reply.header("content-range", `bytes ${start}-${end}/${size}`);
  reply.header("content-length", end - start + 1);
  return reply.send(createReadStream(file, { start, end }));
}
