import {
  HeartIcon,
  MusicNotesIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOnceIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerXIcon,
  VideoCameraIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn, formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";
import { IconButton, PlayDisc } from "./IconButton";
import { Slider } from "./Slider";

export function PlayPauseIcon({ size = 22 }: { size?: number }) {
  const status = usePlayer((s) => s.status);
  if (status === "loading") {
    return <span className="block size-[18px] animate-spin rounded-full border-2 border-current border-t-transparent" />;
  }
  return status === "playing" ? <PauseIcon size={size} weight="fill" /> : <PlayIcon size={size} weight="fill" />;
}

export function Transport({ big = false }: { big?: boolean }) {
  const p = usePlayer(
    useShallow((s) => ({
      hasQueue: s.queue.length > 0,
      status: s.status,
      shuffle: s.shuffle,
      repeat: s.repeat,
      toggle: s.toggle,
      prev: s.prev,
      next: s.next,
      toggleShuffle: s.toggleShuffle,
      cycleRepeat: s.cycleRepeat,
    })),
  );
  const hasTrack = p.hasQueue;
  const RepeatGlyph = p.repeat === "one" ? RepeatOnceIcon : RepeatIcon;
  const repeatLabel = { off: "Repetir: desligado", all: "Repetir: fila", one: "Repetir: faixa" }[p.repeat];
  const iconSize = big ? 26 : 19;

  return (
    <div className={cn("flex items-center", big ? "justify-between" : "gap-2")}>
      <IconButton
        label={p.shuffle ? "Ordem aleatória: ligada" : "Ordem aleatória: desligada"}
        active={p.shuffle}
        size={big ? "lg" : "sm"}
        onClick={p.toggleShuffle}
        disabled={!hasTrack}
      >
        <ShuffleIcon size={big ? 22 : 17} />
        {p.shuffle && <span className="absolute bottom-0.5 size-1 rounded-full bg-accent-text" />}
      </IconButton>
      <IconButton label="Anterior" size={big ? "lg" : "md"} onClick={p.prev} disabled={!hasTrack} className="text-fg">
        <SkipBackIcon size={iconSize} weight="fill" />
      </IconButton>
      <PlayDisc
        label={p.status === "playing" ? "Pausar" : "Tocar"}
        px={big ? 72 : 40}
        onClick={p.toggle}
        disabled={!hasTrack}
      >
        <PlayPauseIcon size={big ? 30 : 20} />
      </PlayDisc>
      <IconButton label="Próxima" size={big ? "lg" : "md"} onClick={p.next} disabled={!hasTrack} className="text-fg">
        <SkipForwardIcon size={iconSize} weight="fill" />
      </IconButton>
      <IconButton
        label={repeatLabel}
        active={p.repeat !== "off"}
        size={big ? "lg" : "sm"}
        onClick={p.cycleRepeat}
        disabled={!hasTrack}
      >
        <RepeatGlyph size={big ? 22 : 17} />
        {p.repeat !== "off" && <span className="absolute bottom-0.5 size-1 rounded-full bg-accent-text" />}
      </IconButton>
    </div>
  );
}

export function Scrubber({ touch = false, className }: { touch?: boolean; className?: string }) {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const buffered = usePlayer((s) => s.buffered);
  const seek = usePlayer((s) => s.seek);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;

  const time = <span className="w-10 shrink-0 font-mono text-[11px] text-fg-3 tabular-nums">{formatTime(shown)}</span>;
  const total = <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fg-3 tabular-nums">{formatTime(duration)}</span>;

  if (touch) {
    return (
      <div className={className}>
        <Slider label="Progresso" value={position} max={duration} buffered={buffered} onChange={seek} onScrub={setScrub} showThumb step={5} valueText={formatTime} />
        <div className="mt-0.5 flex justify-between">
          {time}
          {total}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="text-right">{time}</span>
      <Slider label="Progresso" value={position} max={duration} buffered={buffered} onChange={seek} onScrub={setScrub} step={5} valueText={formatTime} className="flex-1" />
      {total}
    </div>
  );
}

export function Volume({ className }: { className?: string }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const level = muted ? 0 : volume;
  const Glyph = level === 0 ? SpeakerXIcon : level < 0.5 ? SpeakerLowIcon : SpeakerHighIcon;
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton label={muted ? "Ativar som" : "Mudo"} size="sm" onClick={toggleMute}>
        <Glyph size={18} />
      </IconButton>
      <Slider label="Volume" value={level} max={1} step={0.05} live onChange={setVolume} valueText={(v) => `${Math.round(v * 100)}%`} className="w-24" />
    </div>
  );
}

export function FavoriteButton({ track, size = "md" }: { track: Track | null; size?: "sm" | "md" | "lg" }) {
  const isFavorite = useLibrary((s) => !!track && s.favorites.some((t) => t.id === track.id));
  const toggle = useLibrary((s) => s.toggleFavorite);
  return (
    <IconButton
      label={isFavorite ? "Remover das Favoritas" : "Adicionar às Favoritas"}
      active={isFavorite}
      size={size}
      disabled={!track}
      onClick={() => track && void toggle(track)}
    >
      <HeartIcon size={size === "lg" ? 24 : 19} weight={isFavorite ? "fill" : "regular"} />
    </IconButton>
  );
}

/** Audio / Video segmented switch. For songs, Video plays the song's music video when YouTube has one. */
export function ModeSwitch({ className }: { className?: string }) {
  const preferVideo = usePlayer((s) => s.preferVideo);
  const setPreferVideo = usePlayer((s) => s.setPreferVideo);
  const quality = usePlayer((s) => s.quality);
  const setQuality = usePlayer((s) => s.setQuality);
  const showingVideo = usePlayer((s) => s.mediaKind === "video");

  const seg = (on: boolean) =>
    cn(
      "flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-200",
      on ? "bg-surface-4 text-fg shadow-[inset_0_1px_0_var(--highlight)]" : "text-fg-2 hover:text-fg",
    );

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div role="radiogroup" aria-label="Modo de reprodução" className="flex rounded-full bg-surface-1 p-1 ring-1 ring-line">
        <button type="button" role="radio" aria-checked={!preferVideo} className={seg(!preferVideo)} onClick={() => setPreferVideo(false)}>
          <MusicNotesIcon size={15} /> Áudio
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={preferVideo}
          className={seg(preferVideo)}
          onClick={() => setPreferVideo(true)}
          title="Ver o clipe"
        >
          <VideoCameraIcon size={15} /> Vídeo
        </button>
      </div>
      {showingVideo && (
        <button
          type="button"
          onClick={() => setQuality(quality === "sd" ? "hd" : "sd")}
          title={quality === "sd" ? "Mudar para HD (720p, baixa antes de tocar)" : "Mudar para SD (360p, começa mais rápido quando disponível)"}
          className={cn(
            "h-9 rounded-full px-3 font-mono text-[12px] font-semibold ring-1 transition-colors",
            quality === "hd" ? "bg-accent-soft text-accent-text ring-accent/40" : "text-fg-2 ring-line hover:text-fg",
          )}
        >
          {quality === "hd" ? "HD" : "SD"}
        </button>
      )}
    </div>
  );
}
