import { IconButton } from "./IconButton";
import { useT } from "../i18n";
import type { Track } from "../lib/types";
import { useUi } from "../stores/ui";
import { QuotesIcon } from "@phosphor-icons/react";

/**
 * Opens the lyrics for the track in hand. Sits beside the favourite and offline buttons wherever a
 * track is shown on its own, so the lyrics of what is playing are one tap away.
 */
export function LyricsButton({ track, size = "md" }: { track: Track | null; size?: "sm" | "md" | "lg" }) {
  const t = useT();
  if (!track) return null;
  return (
    <IconButton label={t.lyrics.open} size={size} onClick={() => useUi.getState().openLyrics(track)}>
      <QuotesIcon size={size === "lg" ? 24 : size === "sm" ? 16 : 19} />
    </IconButton>
  );
}
