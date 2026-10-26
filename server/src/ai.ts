/**
 * The AI playlist assistant: a prompt goes to an OpenAI-compatible chat endpoint, the model asks for
 * songs through tools that run on this server (YouTube Music search, radio, genres, artists), and the
 * playlist it composes is written into the library like any other.
 *
 * The provider settings (including the API key) live on the device, in the app's own storage: every
 * request here carries them and nothing is written to disk on the server.
 */
import { genre as genrePage, genres } from "./browse.js";
import { msg, tr, type Lang } from "./i18n.js";
import * as library from "./library.js";
import { radio, search } from "./search.js";
import { HttpError, type Playlist, type Track } from "./types.js";

/** How many model turns a single playlist may take before we stop and use what was found. */
const MAX_STEPS = 8;
const DEFAULT_COUNT = 25;
const MAX_COUNT = 60;
/** A job is dropped this long after it started, so the map cannot grow without limit. */
const JOB_TTL = 15 * 60_000;

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * Affinity key for OpenCode's relay: it rejects a request without `x-opencode-session`, and pinning
   * one value per playlist keeps the upstream prompt cache warm for the whole run.
   */
  session: string;
}

export interface PlaylistRequest {
  prompt: string;
  config: unknown;
  lang: Lang;
  /** Send a digest of favorites and history so the playlist fits what the person already listens to. */
  personalize?: boolean;
  count?: number;
}

export type JobStage = "thinking" | "searching" | "creating";

export interface AiJob {
  id: string;
  status: "running" | "done" | "error";
  stage: JobStage;
  /** What is being searched for, or the playlist's name — shown under the progress line. */
  detail: string;
  startedAt: number;
  finishedAt?: number;
  playlist?: Playlist;
  error?: string;
}

/** Reads and checks what the app sent. The key never leaves this request. */
export function readConfig(input: unknown): AiConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  const baseUrl = (typeof c.baseUrl === "string" ? c.baseUrl : "").trim().replace(/\/+$/, "");
  const model = (typeof c.model === "string" ? c.model : "").trim().slice(0, 120);
  const apiKey = (typeof c.apiKey === "string" ? c.apiKey : "").trim().slice(0, 400);
  let url: URL | null = null;
  try {
    url = new URL(baseUrl);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new HttpError(400, msg("aiNotConfigured"));
  if (!model) throw new HttpError(400, msg("aiNotConfigured"));
  return { baseUrl, model, apiKey, session: `musike-${globalThis.crypto.randomUUID()}` };
}

const OPENCODE_SESSION = "x-opencode-session";

/**
 * Where the provider calls go. The browser uses `fetch`; the phone swaps in Capacitor's native HTTP,
 * because a webview's fetch is subject to CORS and the providers send no Access-Control-Allow-Origin.
 */
let httpFetch: typeof fetch = (input, init) => fetch(input, init);

export function useAiFetch(next: typeof fetch) {
  httpFetch = next;
}

function authHeaders(cfg: AiConfig, session?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
  // OpenCode's relay (Zen and Go) refuses a request that carries no session id.
  let host = "";
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    host = "";
  }
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) headers[OPENCODE_SESSION] = session || cfg.session;
  return headers;
}

/** The provider's model list, for the dropdown in Settings. */
export async function listModels(input: unknown): Promise<string[]> {
  const cfg = readConfig(input);
  const res = await httpFetch(`${cfg.baseUrl}/models`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) throw new HttpError(502, msg("aiUnreachable"));
  if (!res.ok) throw new HttpError(502, msg("aiRequestFailed", { detail: `HTTP ${res.status}` }));
  const body = (await res.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
  const raw = Array.isArray(body?.data) ? body!.data : Array.isArray(body?.models) ? body!.models : [];
  const ids = raw
    .map((m) => (typeof m === "string" ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name))
    .filter((id): id is string => typeof id === "string" && !!id.trim())
    .map((id) => id.trim());
  return [...new Set(ids)].slice(0, 400);
}

/** A one-line round trip, so Settings can say whether the endpoint, key and model really work. */
export async function testModel(input: unknown): Promise<{ reply: string }> {
  const cfg = readConfig(input);
  const reply = await chat(cfg, [{ role: "user", content: "Reply with one word: ready" }]);
  return { reply: (reply.content ?? "").trim().slice(0, 80) };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatReply {
  content: string | null;
  tool_calls?: ToolCall[];
}

/** The provider's own words for a failed call, or the status when it said nothing useful. */
function errorDetail(error: { message?: unknown } | string | undefined, status: number): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 200);
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  return `HTTP ${status}`;
}

/** One chat completion. Errors are turned into something the app can show. */
async function chat(cfg: AiConfig, messages: ChatMessage[], tools: unknown[] = [], session?: string): Promise<ChatReply> {
  const res = await httpFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(cfg, session),
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      ...(tools.length ? { tools, tool_choice: "auto" } : { max_tokens: 32 }),
    }),
  }).catch(() => null);
  if (!res) throw new HttpError(502, msg("aiUnreachable"));
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown } | string;
    choices?: { message?: ChatReply }[];
  } | null;
  if (!res.ok) throw new HttpError(502, msg("aiRequestFailed", { detail: errorDetail(body?.error, res.status) }));
  const message = body?.choices?.[0]?.message;
  if (!message) throw new HttpError(502, msg("aiBadResponse"));
  return message;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_tracks",
      description:
        "Search YouTube Music for songs. Use it for a named song, an artist, a mood or a theme. Returns real tracks with their video ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A short search (2-5 words), e.g. 'Arijit Singh' or 'Mon Aami'." },
          artist: { type: "string", description: "Keep only tracks by this artist, e.g. 'Anupam Roy'." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "How many results (default 8)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "similar_tracks",
      description:
        "Songs similar to a track you already have from a previous call (YouTube's radio). Use it to grow a playlist around a seed track.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The video id of the seed track." },
          limit: { type: "integer", minimum: 1, maximum: 30, description: "How many to bring (default 15)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "genre_songs",
      description:
        "Top songs of a YouTube Music genre or mood, by its name (e.g. 'Rock', 'MPB', 'Chill', 'Bengali'). Fall back to search_tracks when the name isn't a genre.",
      parameters: {
        type: "object",
        properties: {
          genre: { type: "string", description: "The genre or mood name." },
          limit: { type: "integer", minimum: 1, maximum: 30, description: "How many (default 15)." },
        },
        required: ["genre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "artist_songs",
      description: "One artist's best-known songs, by name. Use it when the request names a performer.",
      parameters: {
        type: "object",
        properties: {
          artist: { type: "string", description: "The artist's name." },
          limit: { type: "integer", minimum: 1, maximum: 30, description: "How many (default 12)." },
        },
        required: ["artist"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_playlist",
      description:
        "Create the playlist in the person's library. Call this exactly once, at the end, with only video ids that the other tools returned. Never invent ids.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short playlist name, in the person's language." },
          track_ids: { type: "array", items: { type: "string" }, description: "Video ids, in playing order." },
          note: { type: "string", description: "One sentence for the person about what you picked." },
        },
        required: ["name", "track_ids"],
      },
    },
  },
];

/** What the person already listens to, so "personalized" means something. */
async function libraryDigest(lang: Lang): Promise<string> {
  const lib = await library.getLibrary();
  const tally = new Map<string, number>();
  const count = (tracks: Track[], weight: number) => {
    for (const t of tracks) {
      const artist = (t.artist || "").trim();
      if (artist) tally.set(artist, (tally.get(artist) ?? 0) + weight);
    }
  };
  count(lib.favorites, 3);
  count(lib.history, 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([artist]) => artist);
  const playlists = lib.playlists.slice(0, 10).map((p) => p.name);
  const recent = lib.history.slice(0, 8).map((t) => `${t.title} — ${t.artist}`.trim());
  const lines: string[] = [];
  if (top.length) lines.push(`${lang === "pt-BR" ? "Artistas mais ouvidos" : "Most played artists"}: ${top.join(", ")}`);
  if (recent.length) lines.push(`${lang === "pt-BR" ? "Ouvidas recentemente" : "Recently played"}: ${recent.join("; ")}`);
  if (playlists.length) lines.push(`${lang === "pt-BR" ? "Playlists existentes" : "Existing playlists"}: ${playlists.join(", ")}`);
  return lines.join("\n");
}

function systemPrompt(lang: Lang, count: number, digest: string): string {
  const language = lang === "pt-BR" ? "Brazilian Portuguese" : "English";
  return [
    "You build music playlists inside a personal music app backed by YouTube Music.",
    `The person writes a request in any language. Answer and name the playlist in ${language}.`,
    `Target ${count} tracks (never more than ${MAX_COUNT}).`,
    "",
    "How to work:",
    "1. Call the tools to find real songs. Search for seeds first, then use similar_tracks and/or genre_songs/artist_songs to reach the target.",
    "2. Search with short queries (2-5 words). YouTube Music matches titles and names best: 'Anupam Roy', 'Mon Aami' — not 'upbeat Bengali road trip songs'. Use artist_songs and genre_songs for a themed request.",
    "3. Only use video ids that a tool returned in this conversation. Never guess or reuse an id from memory.",
    "4. If the request names a language, region or era, check every result against it and drop the ones that clearly don't belong.",
    "5. Prefer a mix: the obvious hits plus a few deeper cuts a fan would recognize. Skip duplicates and live/cover versions unless asked.",
    "6. When you have enough tracks, call create_playlist once with the ids in playing order and a short evocative name.",
    "7. After create_playlist succeeds, reply with one short sentence for the person. Do not list every track.",
    "",
    digest ? `What this person already listens to:\n${digest}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const compact = (t: Track) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration });

/** A usable name when the model never named the playlist itself: the request, minus the instructions. */
function nameFromPrompt(prompt: string): string {
  const first = (prompt.trim().split(/[\n.!?]/)[0] ?? "").trim();
  const cleaned = first
    .replace(/,?\s*(about|around|with|of)?\s*\d+\s*(tracks?|songs?|faixas?|m[uú]sicas?)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[,;:\-–—]+$/, "")
    .trim();
  const name = cleaned || first || prompt.trim();
  if (name.length <= 48) return name;
  const cut = name.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 48).trim()}…`;
}

interface ToolContext {
  lang: Lang;
  known: Map<string, Track>;
  /** Set by create_playlist once the library has the playlist. */
  playlist: Playlist | null;
  limit: number;
  step: (stage: JobStage, detail: string) => void;
}

async function runTool(call: ToolCall, ctx: ToolContext): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = (JSON.parse(call.function.arguments || "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return { error: "Arguments were not valid JSON." };
  }
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown, fallback: number, max: number) => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(Math.max(n, 1), max);
  };
  const keep = (tracks: Track[], limit: number) => {
    const out: Track[] = [];
    for (const t of tracks) {
      if (!ctx.known.has(t.id)) ctx.known.set(t.id, t);
      if (!out.some((x) => x.id === t.id)) out.push(t);
      if (out.length >= limit) break;
    }
    return out.map(compact);
  };

  switch (call.function.name) {
    case "search_tracks": {
      const query = text(args.query).slice(0, 200);
      if (!query) return { error: "Empty query." };
      const wantArtist = text(args.artist).toLocaleLowerCase();
      ctx.step("searching", wantArtist ? `${query} — ${args.artist}` : query);
      const found = await search(query, "song", ctx.lang).catch(() => []);
      const tracks = wantArtist
        ? found.filter((t) => t.artist.toLocaleLowerCase().includes(wantArtist.split(/\s+/)[0] ?? wantArtist))
        : found;
      return { tracks: keep(tracks, num(args.limit, 8, 20)), ...(wantArtist && !tracks.length ? { note: "No track by that artist for this query." } : {}) };
    }
    case "similar_tracks": {
      const id = text(args.id);
      const seed = ctx.known.get(id);
      if (!seed) return { error: "Unknown track id: only ids returned by the other tools can be used." };
      ctx.step("searching", `${seed.title} — ${seed.artist}`.trim());
      const tracks = await radio(id).catch(() => []);
      return { tracks: keep(tracks, num(args.limit, 15, 30)) };
    }
    case "genre_songs": {
      const name = text(args.genre).slice(0, 80);
      if (!name) return { error: "Empty genre." };
      ctx.step("searching", name);
      const limit = num(args.limit, 15, 30);
      const list = await genres(ctx.lang).catch(() => []);
      const hit =
        list.find((g) => g.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ??
        list.find((g) => g.name.toLocaleLowerCase().includes(name.toLocaleLowerCase())) ??
        list.find((g) => name.toLocaleLowerCase().includes(g.name.toLocaleLowerCase()));
      if (hit) {
        const page = await genrePage(hit.id, ctx.lang).catch(() => null);
        if (page?.tracks.length) return { genre: hit.name, tracks: keep(page.tracks, limit) };
      }
      // Not a genre YouTube Music knows: a plain search is the closest thing.
      const tracks = await search(name, "song", ctx.lang).catch(() => []);
      return { genre: null, tracks: keep(tracks, limit) };
    }
    case "artist_songs": {
      const artist = text(args.artist).slice(0, 120);
      if (!artist) return { error: "Empty artist." };
      ctx.step("searching", artist);
      const limit = num(args.limit, 12, 30);
      const found = await search(artist, "song", ctx.lang).catch(() => []);
      const key = artist.toLocaleLowerCase().split(/\s+/)[0] ?? artist.toLocaleLowerCase();
      const mine = found.filter((t) => t.artist.toLocaleLowerCase().includes(key));
      const pool = mine.length >= 4 ? mine : found;
      // A search only shows the hits; the radio of the best match digs deeper.
      if (pool.length < limit && pool[0]) {
        const more = await radio(pool[0].id).catch(() => []);
        const seen = new Set(pool.map((t) => t.id));
        return { tracks: keep([...pool, ...more.filter((t) => !seen.has(t.id))], limit) };
      }
      return { tracks: keep(pool, limit) };
    }
    case "create_playlist": {
      // A model may emit the call twice in one turn: the person gets one playlist, not two.
      if (ctx.playlist) return { ok: true, name: ctx.playlist.name, tracks: ctx.playlist.tracks.length, duplicate: true };
      const name = text(args.name).slice(0, 80);
      const ids = Array.isArray(args.track_ids) ? args.track_ids : [];
      const tracks: Track[] = [];
      for (const raw of ids) {
        const id = typeof raw === "string" ? raw : "";
        const track = ctx.known.get(id);
        if (track && !tracks.some((t) => t.id === track.id)) tracks.push(track);
        if (tracks.length >= ctx.limit) break;
      }
      if (!name) return { error: "The playlist needs a name." };
      if (!tracks.length) return { error: "No valid track ids. Use ids returned by the other tools." };
      ctx.step("creating", name);
      ctx.playlist = await library.createPlaylist(name, tracks);
      return { ok: true, name: ctx.playlist.name, tracks: tracks.length };
    }
    default:
      return { error: `Unknown tool: ${call.function.name}` };
  }
}

const jobs = new Map<string, AiJob>();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.startedAt > JOB_TTL) jobs.delete(id);
}

export function getJob(id: string): AiJob {
  pruneJobs();
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, msg("aiJobNotFound"));
  return job;
}

/** Runs the whole assistant in the background so the app can poll for progress. */
export function startPlaylistJob(input: PlaylistRequest): { jobId: string } {
  const cfg = readConfig(input.config);
  const prompt = (typeof input.prompt === "string" ? input.prompt : "").trim().slice(0, 600);
  if (!prompt) throw new HttpError(400, msg("aiPromptRequired"));
  const count = Math.min(Math.max(Math.round(Number(input.count) || DEFAULT_COUNT), 5), MAX_COUNT);
  const job: AiJob = {
    id: globalThis.crypto.randomUUID(),
    status: "running",
    stage: "thinking",
    detail: "",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  cfg.session = job.id;
  pruneJobs();

  void (async () => {
    const step = (stage: JobStage, detail: string) => {
      job.stage = stage;
      job.detail = detail;
    };
    try {
      const digest = input.personalize ? await libraryDigest(input.lang).catch(() => "") : "";
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt(input.lang, count, digest) },
        { role: "user", content: prompt },
      ];
      const ctx: ToolContext = { lang: input.lang, known: new Map(), playlist: null, limit: count, step };

      let nudged = false;
      for (let turn = 0; turn < MAX_STEPS && !ctx.playlist; turn++) {
        const reply = await chat(cfg, messages, TOOLS, job.id);
        const calls = reply.tool_calls ?? [];
        if (!calls.length) {
          // Small models often describe the list instead of saving it: one nudge, then the fallback below.
          if (ctx.known.size && !nudged) {
            nudged = true;
            messages.push({ role: "assistant", content: reply.content ?? null });
            messages.push({
              role: "user",
              content: `You already have ${ctx.known.size} candidate tracks. Call create_playlist now with the ids you kept, in playing order, and nothing else.`,
            });
            continue;
          }
          break;
        }
        messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const result = await runTool(call, ctx).catch((e: Error) => ({ error: e.message }));
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      // The model stopped without creating anything but did find songs: the person still gets a playlist.
      if (!ctx.playlist && ctx.known.size) {
        step("creating", nameFromPrompt(prompt));
        ctx.playlist = await library.createPlaylist(nameFromPrompt(prompt), [...ctx.known.values()].slice(0, count));
      }
      if (!ctx.playlist) throw new HttpError(502, msg("aiNoTracks"));

      job.playlist = ctx.playlist;
      job.status = "done";
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = "error";
      job.finishedAt = Date.now();
      job.error = e instanceof HttpError ? tr(input.lang, e.text) : (e as Error).message;
    }
  })();

  return { jobId: job.id };
}
