import { CheckCircleIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { offlineSupported } from "../lib/offline";
import type { Track } from "../lib/types";
import { useOffline } from "../stores/offline";
import { IconButton } from "./IconButton";

/**
 * Whether the track in hand is kept for offline play, and a way to change that. Sits beside the
 * favourite button wherever a track is shown on its own — the Now Playing screen and the desktop
 * player bar — so it is obvious at a glance whether the song will play without a connection.
 */
export function OfflineTrackButton({ track, size = "md" }: { track: Track | null; size?: "sm" | "md" | "lg" }) {
  const t = useT();
  const kept = useOffline((s) => (track ? s.ids.has(track.id) : false));

  if (!offlineSupported() || !track) return null;

  const glyph = size === "lg" ? 24 : size === "sm" ? 16 : 19;

  return (
    <IconButton
      label={kept ? t.trackMenu.offlineRemove : t.trackMenu.offlineKeep}
      active={kept}
      size={size}
      onClick={() => void useOffline.getState().toggle(track)}
    >
      {kept ? <CheckCircleIcon size={glyph} weight="fill" /> : <DownloadSimpleIcon size={glyph} />}
    </IconButton>
  );
}
