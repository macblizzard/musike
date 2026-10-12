import { ArrowUpLeftIcon, LinkIcon, MagnifyingGlassIcon, PlayIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Artwork } from "../components/Artwork";
import { EmptyState, PageHeader } from "../components/Page";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { MD, useMediaQuery } from "../hooks/useMediaQuery";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";

const RECENT_KEY = "musike:recent-searches";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

/** Accepts youtube.com/watch?v=, youtu.be/, music.youtube.com and /shorts/ links. */
function videoIdFromUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(url.hostname)) return null;
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") ?? url.pathname.split("/shorts/")[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id.slice(0, 11)) ? id.slice(0, 11) : null;
  } catch {
    return null;
  }
}

type Kind = "song" | "video";

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const kind: Kind = params.get("tipo") === "videos" ? "video" : "song";
  const [text, setText] = useState(q);
  const [results, setResults] = useState<Track[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [recent, setRecent] = useState(readRecent);
  const [linkTrack, setLinkTrack] = useState<Track | "loading" | "error" | null>(null);
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const isMd = useMediaQuery(MD);
  const playTrack = usePlayer((s) => s.playTrack);

  const linkId = videoIdFromUrl(text);

  const setQuery = (next: string, nextKind = kind) => {
    const p = new URLSearchParams();
    if (next.trim()) p.set("q", next.trim());
    if (nextKind === "video") p.set("tipo", "videos");
    setParams(p, { replace: true });
  };

  // Keep the box in sync when navigating back to an earlier query (without eating a trailing space while typing).
  useEffect(() => setText((t) => (t.trim() === q ? t : q)), [q]);

  // Search as you type, debounced.
  useEffect(() => {
    if (linkId || text.trim() === q) return;
    const t = setTimeout(() => setQuery(text), 380);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (!q) {
      setResults(null);
      setState("idle");
      return;
    }
    const ctrl = new AbortController();
    setState("loading");
    api
      .search(q, kind, ctrl.signal)
      .then((tracks) => {
        setResults(tracks);
        setState("ok");
        const next = [q, ...readRecent().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
        saveRecent(next);
        setRecent(next);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setError(e.message);
        setState("error");
      });
    return () => ctrl.abort();
  }, [q, kind, retry]);

  useEffect(() => {
    const term = text.trim();
    if (!term || linkId) return setSuggestions([]);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .suggest(term, ctrl.signal)
        .then((s) => setSuggestions(s.filter((x) => x.toLowerCase() !== term.toLowerCase()).slice(0, 6)))
        .catch(() => {});
    }, 140);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, linkId]);

  useEffect(() => {
    if (!linkId) return setLinkTrack(null);
    const ctrl = new AbortController();
    setLinkTrack("loading");
    api
      .prepare(linkId, ctrl.signal)
      .then((r) =>
        setLinkTrack({
          id: r.id,
          title: r.title,
          artist: "Link do YouTube",
          duration: r.duration,
          thumb: `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`,
          art: `https://i.ytimg.com/vi/${r.id}/hq720.jpg`,
          kind: "video",
        }),
      )
      .catch((e: Error) => e.name !== "AbortError" && setLinkTrack("error"));
    return () => ctrl.abort();
  }, [linkId]);

  useEffect(() => {
    if (isMd && !q) input.current?.focus();
  }, []);

  const tab = (k: Kind, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === k}
      onClick={() => setQuery(text || q, k)}
      className={cn(
        "h-9 rounded-full px-4 text-sm font-medium transition-colors duration-200",
        kind === k ? "bg-fg text-bg" : "bg-surface-3 text-fg-2 hover:text-fg",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="pb-8">
      <PageHeader title="Buscar" />

      <div className="flex flex-col gap-3 px-4 pt-1 md:px-6">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            input.current?.blur();
            if (!linkId) setQuery(text);
          }}
          className="relative"
        >
          <label htmlFor="search-input" className="sr-only">
            Buscar músicas, artistas, vídeos ou colar um link do YouTube
          </label>
          <MagnifyingGlassIcon size={20} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-fg-2" />
          <input
            id="search-input"
            ref={input}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Músicas, artistas ou link do YouTube"
            className="h-12 w-full rounded-full border border-line-strong bg-surface-2 pr-24 pl-12 text-[16px] placeholder:text-fg-3 focus:border-accent focus:bg-surface-1 focus:outline-none md:h-13 [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-2">
            {!text && <kbd className="kbd hidden md:inline">/</kbd>}
            {text && (
              <button
                type="button"
                onClick={() => {
                  setText("");
                  setQuery("");
                  input.current?.focus();
                }}
                aria-label="Limpar busca"
                className="grid size-9 place-items-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg"
              >
                <XIcon size={18} />
              </button>
            )}
          </div>
        </form>

        {suggestions.length > 0 && (
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setText(s);
                  setQuery(s);
                }}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[13px] text-fg-2 ring-1 ring-line transition-colors hover:text-fg"
              >
                <ArrowUpLeftIcon size={13} className="text-fg-3" /> {s}
              </button>
            ))}
          </div>
        )}

        {!linkId && (
          <div role="tablist" aria-label="Tipo de resultado" className="flex gap-2">
            {tab("song", "Músicas")}
            {tab("video", "Vídeos")}
          </div>
        )}
      </div>

      <div className="mt-4 px-2 md:px-3">
        {linkId && (
          <div className="px-2 md:px-3">
            {linkTrack === "loading" && <TrackListSkeleton rows={1} />}
            {linkTrack && linkTrack !== "loading" && linkTrack !== "error" && (
              <button
                type="button"
                onClick={() => playTrack(linkTrack)}
                className="flex w-full items-center gap-4 rounded-[16px] bg-surface-2 p-3 text-left ring-1 ring-line transition-colors hover:bg-surface-3"
              >
                <Artwork src={linkTrack.thumb} className="aspect-video w-28 rounded-[10px] md:w-36" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-accent-text">
                    <LinkIcon size={14} /> Link do YouTube
                  </span>
                  <span className="mt-1 line-clamp-2 font-medium">{linkTrack.title}</span>
                </span>
                <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
                  <PlayIcon size={22} weight="fill" />
                </span>
              </button>
            )}
            {linkTrack === "error" && (
              <p className="px-1 py-6 text-sm text-fg-2">Não foi possível abrir esse link. Confira se o vídeo é público.</p>
            )}
          </div>
        )}

        {!linkId && state === "loading" && <TrackListSkeleton />}

        {!linkId && state === "error" && (
          <EmptyState
            icon={<WarningCircleIcon size={28} />}
            title="A busca falhou"
            body={error}
            action={
              <button
                type="button"
                onClick={() => setRetry((n) => n + 1)}
                className="mt-2 h-11 rounded-full bg-surface-3 px-6 text-sm font-medium hover:bg-surface-4"
              >
                Tentar de novo
              </button>
            }
          />
        )}

        {!linkId && state === "ok" && results && results.length === 0 && (
          <EmptyState
            icon={<MagnifyingGlassIcon size={28} />}
            title="Nada encontrado"
            body={`Nenhum resultado para "${q}". Tente outro termo ou a aba ${kind === "song" ? "Vídeos" : "Músicas"}.`}
          />
        )}

        {!linkId && state === "ok" && results && results.length > 0 && <TrackList tracks={results} showAlbum={kind === "song"} />}

        {!linkId && state === "idle" && (
          <div className="px-2 md:px-3">
            {recent.length > 0 ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold tracking-tight">Buscas recentes</h2>
                  <button
                    type="button"
                    onClick={() => {
                      saveRecent([]);
                      setRecent([]);
                    }}
                    className="text-sm font-medium text-fg-2 hover:text-fg"
                  >
                    Limpar
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {recent.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        setText(r);
                        setQuery(r);
                      }}
                      className="h-10 rounded-full bg-surface-2 px-4 text-sm ring-1 ring-line transition-colors hover:bg-surface-3"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<MagnifyingGlassIcon size={28} />}
                title="O que vai tocar hoje?"
                body="Busque por música, artista ou álbum. Para clipes e ao vivo, use a aba Vídeos. Também dá para colar um link do YouTube."
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
