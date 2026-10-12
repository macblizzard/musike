import {
  BooksIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  HeartIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { cn, plural } from "../lib/format";
import { useLibrary } from "../stores/library";
import { needsAttention, useSystem } from "../stores/system";
import { useUi } from "../stores/ui";
import { Artwork } from "./Artwork";
import { Logo, LogoMark } from "./Brand";
import { NamePlaylistDialog } from "./Dialogs";

const nav = [
  { to: "/", label: "Início", Icon: HouseIcon, end: true },
  { to: "/buscar", label: "Buscar", Icon: MagnifyingGlassIcon, end: false },
  { to: "/biblioteca", label: "Biblioteca", Icon: BooksIcon, end: false },
];

/** Settings entry. Shows a dot (and on the wide rail, an "Atualizar" pill) when yt-dlp needs attention. */
function SettingsButton() {
  const info = useSystem((s) => s.info);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const attention = needsAttention(info);
  const updatable = !!info?.ytdlp.updateAvailable || !info?.ytdlp.path;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={attention ? "Ajustes (atenção necessária)" : "Ajustes"}
      title="Ajustes"
      className="relative flex h-10 w-full items-center justify-center gap-2 rounded-full px-3 text-sm text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg xl:justify-start"
    >
      <GearSixIcon size={19} />
      <span className="hidden flex-1 text-left xl:inline">Ajustes</span>
      {attention && (
        <>
          <span className="absolute top-2 right-[calc(50%-14px)] size-2 rounded-full bg-accent ring-2 ring-surface-2 xl:hidden" />
          <span className="hidden rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-text xl:inline">
            {updatable ? "Atualizar" : "Verificar"}
          </span>
        </>
      )}
    </button>
  );
}

/** Shared tile: square icon/art with an active Volt ring. Labels appear on the expanded rail (≥1280px). */
function RailLink({ to, label, sub, end, children }: { to: string; label: string; sub?: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          "group flex items-center justify-center gap-3 rounded-[14px] p-1.5 transition-colors duration-200 xl:justify-start",
          "hover:bg-surface-3 xl:pr-3",
          isActive && "xl:bg-surface-3",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-[12px] transition-[box-shadow,transform] duration-200 ease-out-expo group-active:scale-95",
              isActive ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-2" : "",
            )}
          >
            {children}
          </span>
          <span className="hidden min-w-0 xl:block">
            <span className={cn("block truncate text-sm font-medium", isActive ? "text-fg" : "text-fg-2 group-hover:text-fg")}>
              {label}
            </span>
            {sub && <span className="block truncate text-xs text-fg-3">{sub}</span>}
          </span>
        </>
      )}
    </NavLink>
  );
}

export function Rail() {
  const playlists = useLibrary((s) => s.playlists);
  const favorites = useLibrary((s) => s.favorites);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <aside className="island hidden w-[78px] shrink-0 md:flex xl:w-[256px]">
      <div className="island-core flex w-full flex-col overflow-hidden">
        <div className="flex h-16 items-center justify-center xl:justify-start xl:px-4">
          <LogoMark className="size-8 text-accent-text xl:hidden" />
          <span className="hidden xl:block">
            <Logo />
          </span>
        </div>

        <nav aria-label="Navegação principal" className="flex flex-col gap-1 px-2">
          {nav.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                cn(
                  "flex h-11 items-center justify-center gap-3 rounded-full transition-colors duration-200 xl:justify-start xl:px-4",
                  isActive ? "bg-surface-4 text-fg" : "text-fg-2 hover:bg-surface-3 hover:text-fg",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} weight={isActive ? "fill" : "regular"} />
                  <span className="hidden text-sm font-medium xl:inline">{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mx-4 my-3 h-px bg-line" />

        <div className="flex items-center justify-between px-4 pb-1">
          <span className="hidden text-xs font-medium text-fg-3 xl:block">Sua coleção</span>
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label="Nova playlist"
            title="Nova playlist"
            className="mx-auto grid size-8 place-items-center rounded-full text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg xl:mx-0"
          >
            <PlusIcon size={18} />
          </button>
        </div>

        <div className="scroll-area flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          <RailLink to="/favoritas" label="Favoritas" sub={plural(favorites.length, "faixa", "faixas")}>
            <span className="grid size-full place-items-center bg-accent-soft text-accent-text">
              <HeartIcon size={20} weight="fill" />
            </span>
          </RailLink>
          <RailLink to="/historico" label="Tocadas recentemente" sub="Histórico">
            <span className="grid size-full place-items-center bg-surface-3 text-fg-2">
              <ClockCounterClockwiseIcon size={20} />
            </span>
          </RailLink>
          {playlists.map((p) => (
            <RailLink key={p.id} to={`/playlist/${p.id}`} label={p.name} sub={plural(p.tracks.length, "faixa", "faixas")}>
              <Artwork src={p.tracks[0]?.thumb} className="size-full" iconSize={18} />
            </RailLink>
          ))}
        </div>

        <div className="flex border-t border-line p-2">
          <SettingsButton />
        </div>
      </div>

      <NamePlaylistDialog
        open={creating}
        title="Nova playlist"
        action="Criar"
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          const p = await createPlaylist(name);
          setCreating(false);
          if (p) navigate(`/playlist/${p.id}`);
        }}
      />
    </aside>
  );
}
