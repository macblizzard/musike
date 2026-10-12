import { QueueIcon, XIcon } from "@phosphor-icons/react";
import { cn, formatTime } from "../lib/format";
import { usePlayer } from "../player/player";
import { Artwork } from "./Artwork";
import { Equalizer } from "./Brand";

export function QueueList({ compact = false }: { compact?: boolean }) {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const live = usePlayer((s) => s.status === "playing" || s.status === "loading");
  const jumpTo = usePlayer((s) => s.jumpTo);
  const removeAt = usePlayer((s) => s.removeAt);
  const clearUpcoming = usePlayer((s) => s.clearUpcoming);
  const autoRadio = usePlayer((s) => s.autoRadio);
  const setAutoRadio = usePlayer((s) => s.setAutoRadio);

  const current = queue[index];
  const upcoming = queue.slice(index + 1);

  if (!current) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="grid size-14 place-items-center rounded-[14px] bg-surface-3 text-fg-3">
          <QueueIcon size={26} />
        </span>
        <p className="font-medium">A fila está vazia</p>
        <p className="max-w-[28ch] text-sm text-fg-2">Toque uma música ou use "Adicionar à fila" no menu de qualquer faixa.</p>
      </div>
    );
  }

  const row = (i: number, isCurrent: boolean) => {
    const t = queue[i];
    return (
      <li key={`${t.id}-${i}`} className="group relative flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-3">
        <button type="button" onClick={() => jumpTo(i)} className="absolute inset-0 rounded-xl" aria-label={`Tocar ${t.title}`} />
        <Artwork src={t.thumb} className="pointer-events-none size-10 rounded-[8px]" />
        <div className="pointer-events-none min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", isCurrent ? "text-accent-text" : "text-fg")}>{t.title}</p>
          <p className="truncate text-xs text-fg-2">{t.artist}</p>
        </div>
        {isCurrent ? (
          <Equalizer live={live} className="mr-2" />
        ) : (
          <>
            <span className="pointer-events-none font-mono text-xs text-fg-3 tabular-nums group-hover:hidden">
              {t.duration ? formatTime(t.duration) : ""}
            </span>
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label={`Remover ${t.title} da fila`}
              title="Remover da fila"
              className="relative z-10 hidden size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-4 hover:text-fg group-hover:grid max-md:grid"
            >
              <XIcon size={16} />
            </button>
          </>
        )}
      </li>
    );
  };

  return (
    <div className={cn("flex flex-col gap-4", compact ? "" : "pb-4")}>
      <section>
        <h3 className="px-2 pb-1.5 text-xs font-medium text-fg-3">Tocando agora</h3>
        <ul>{row(index, true)}</ul>
      </section>

      <section>
        <div className="flex items-center justify-between px-2 pb-1.5">
          <h3 className="text-xs font-medium text-fg-3">
            A seguir <span className="font-mono">{upcoming.length}</span>
          </h3>
          {upcoming.length > 0 && (
            <button type="button" onClick={clearUpcoming} className="text-xs font-medium text-fg-2 hover:text-fg">
              Limpar
            </button>
          )}
        </div>
        {upcoming.length ? (
          <ul>{upcoming.map((_, k) => row(index + 1 + k, false))}</ul>
        ) : (
          <p className="px-2 text-sm text-fg-2">Nada na fila. {autoRadio ? "O rádio continua quando acabar." : ""}</p>
        )}
      </section>

      <label className="mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-surface-1 px-3 py-2.5 ring-1 ring-line">
        <span>
          <span className="block text-sm font-medium">Rádio automático</span>
          <span className="block text-xs text-fg-2">Continua com músicas parecidas quando a fila acabar</span>
        </span>
        <input
          type="checkbox"
          checked={autoRadio}
          onChange={(e) => setAutoRadio(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-accent",
            autoRadio ? "bg-accent" : "bg-surface-4",
          )}
        >
          <span
            className={cn(
              "absolute top-1 left-1 size-4 rounded-full transition-transform duration-200 ease-out-expo",
              autoRadio ? "translate-x-4 bg-accent-ink" : "bg-fg-2",
            )}
          />
        </span>
      </label>
    </div>
  );
}
