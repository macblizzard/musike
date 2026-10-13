import { CircleNotchIcon, MusicNotesIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { Artwork } from "../components/Artwork";
import { BackButton, EmptyState, PageHeader } from "../components/Page";
import { SelectableTrackList, Short } from "../components/Selection";
import { TrackListSkeleton } from "../components/TrackList";
import { useRemote } from "../hooks/useRemote";
import { api } from "../lib/api";
import { cn, plural } from "../lib/format";
import type { GenreArtist, GenrePage } from "../lib/types";

type View = "artists" | "tracks";

/** A genre: its bands and artists (each opens their greatest hits) or all its songs in one list. */
export default function Genre() {
  const { id = "" } = useParams();
  // Keyed, so switching genres starts from a clean state.
  return <GenreBody key={id} id={id} />;
}

interface MoreArtists {
  artists: GenreArtist[];
  hasMore: boolean;
}

// Artists added with "Carregar mais", kept per genre: coming back from an artist shows the same long list.
const moreMemo = new Map<string, MoreArtists>();

function GenreBody({ id }: { id: string }) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("ver") === "musicas" ? "tracks" : "artists";
  const page = useRemote<GenrePage>(`genre:${id}`, (signal) => api.genre(id, signal));
  const name = (page.status === "ok" && page.data.name) || (location.state as { name?: string } | null)?.name || "Gênero";
  const [more, setMore] = useState<MoreArtists | undefined>(() => moreMemo.get(id));
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");

  const artists = page.status === "ok" ? [...page.data.artists, ...(more?.artists ?? [])] : [];
  const hasMore = page.status === "ok" && (more ? more.hasMore : page.data.hasMoreArtists);

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError("");
    try {
      const next = await api.genreArtists(id, artists.length);
      const known = new Set(artists.map((a) => a.id));
      const merged = { artists: [...(more?.artists ?? []), ...next.artists.filter((a) => !known.has(a.id))], hasMore: next.hasMore };
      moreMemo.set(id, merged);
      setMore(merged);
    } catch (e) {
      setMoreError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const tab = (v: View, label: ReactNode, count?: string | number) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => setParams(v === "tracks" ? { ver: "musicas" } : {}, { replace: true, state: location.state })}
      className={cn(
        "h-9 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors duration-200",
        view === v ? "bg-fg text-bg" : "bg-surface-3 text-fg-2 hover:text-fg",
      )}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 font-mono text-xs opacity-60">{count}</span>}
    </button>
  );

  return (
    <div className="pb-8">
      <PageHeader title={name} actions={<BackButton fallback="/buscar" />} />

      <div role="tablist" aria-label="Ver por" className="flex gap-2 px-4 pt-1 pb-4 md:px-6">
        {tab("artists", <Short phone="Artistas" wide="Bandas e artistas" />, page.status === "ok" ? `${artists.length}${hasMore ? "+" : ""}` : undefined)}
        {tab("tracks", <Short phone="Músicas" wide="Todas as músicas" />, page.status === "ok" ? page.data.tracks.length : undefined)}
      </div>

      {page.status === "loading" && (view === "artists" ? <ArtistGridSkeleton /> : <TrackListSkeleton />)}

      {page.status === "error" && (
        <EmptyState
          icon={<WarningCircleIcon size={28} />}
          title="Não deu para abrir este gênero"
          body={page.message}
          action={
            <button
              type="button"
              onClick={page.retry}
              className="mt-2 h-11 rounded-full bg-surface-3 px-6 text-sm font-medium hover:bg-surface-4"
            >
              Tentar de novo
            </button>
          }
        />
      )}

      {page.status === "ok" && view === "artists" && (
        artists.length ? (
          <>
            <p className="px-4 pb-3 text-sm text-fg-2 md:px-6">Escolha uma banda ou artista para ver os maiores sucessos.</p>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 sm:grid-cols-3 md:px-6 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {artists.map((a) => (
                <li key={a.id}>
                  <Link to={`/buscar/artista/${a.id}`} state={{ name: a.name }} className="group flex flex-col gap-2">
                    <span className="block overflow-hidden rounded-[14px]">
                      <Artwork
                        src={a.art}
                        fallback={a.thumb}
                        className="aspect-square w-full transition-transform duration-300 ease-out-expo group-hover:scale-[1.04]"
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{a.name}</span>
                      <span className="block truncate text-xs text-fg-2">{a.hits.join(" · ")}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex flex-col items-center gap-2 px-4 pt-8 md:px-6">
              {hasMore ? (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex h-11 items-center gap-2 rounded-full bg-surface-3 px-6 text-sm font-medium transition-transform hover:bg-surface-4 active:scale-[0.97] disabled:opacity-70"
                >
                  {loadingMore ? (
                    <>
                      <CircleNotchIcon size={18} className="animate-spin" /> Procurando mais artistas…
                    </>
                  ) : (
                    "Carregar mais"
                  )}
                </button>
              ) : (
                artists.length > page.data.artists.length && (
                  <p className="text-sm text-fg-3">Fim da lista: {plural(artists.length, "artista", "artistas")}</p>
                )
              )}
              {moreError && (
                <p role="alert" className="text-sm text-danger">
                  {moreError}
                </p>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<MusicNotesIcon size={28} />}
            title="Nenhum artista listado"
            body="Este gênero só tem playlists. Veja todas as músicas na outra aba."
          />
        )
      )}

      {page.status === "ok" && view === "tracks" && (
        page.data.tracks.length ? (
          <SelectableTrackList key={id} tracks={page.data.tracks} />
        ) : (
          <EmptyState icon={<MusicNotesIcon size={28} />} title="Nenhuma música listada" body="Tente outro gênero." />
        )
      )}
    </div>
  );
}

function ArtistGridSkeleton() {
  return (
    <ul aria-label="Carregando" className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 sm:grid-cols-3 md:px-6 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {Array.from({ length: 12 }, (_, i) => (
        <li key={i} className="flex flex-col gap-2">
          <span className="skeleton aspect-square w-full rounded-[14px]" />
          <span className="skeleton h-3.5 w-2/3 rounded-full" />
          <span className="skeleton h-3 w-1/2 rounded-full" />
        </li>
      ))}
    </ul>
  );
}
