import { Link } from "react-router";
import { useRemote } from "../hooks/useRemote";
import { api } from "../lib/api";
import type { Genre } from "../lib/types";

/** YouTube Music's genre list as chips; each opens the genre's artists and songs. */
export function GenrePanel({ id }: { id: string }) {
  const genres = useRemote<Genre[]>("genres", () => api.genres());

  return (
    <div id={id} className="rounded-[16px] bg-surface-2 p-3 ring-1 ring-line">
      <p className="mb-2.5 px-1 text-xs font-medium text-fg-2">Explorar por gênero</p>

      {genres.status === "loading" && (
        <div aria-label="Carregando" className="flex flex-wrap gap-2">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="skeleton h-9 rounded-full" style={{ width: `${64 + ((i * 23) % 56)}px` }} />
          ))}
        </div>
      )}

      {genres.status === "error" && (
        <p className="px-1 text-sm text-fg-2">
          {genres.message}{" "}
          <button type="button" onClick={genres.retry} className="font-medium text-fg underline-offset-2 hover:underline">
            Tentar de novo
          </button>
        </p>
      )}

      {genres.status === "ok" && (
        <ul className="flex flex-wrap gap-2">
          {genres.data.map((g) => (
            <li key={g.id}>
              <Link
                to={`/buscar/genero/${encodeURIComponent(g.id)}`}
                state={{ name: g.name }}
                className="block h-9 rounded-full bg-surface-3 px-4 text-sm leading-9 transition-colors hover:bg-surface-4"
              >
                {g.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
