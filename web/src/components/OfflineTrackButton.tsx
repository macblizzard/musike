import { CheckCircleIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { drop, keep, keptIds, offlineSupported } from "../lib/offline";
import type { Track } from "../lib/types";
import { toast } from "../stores/ui";
import { IconButton } from "./IconButton";

/**
 * Whether the track in hand is kept for offline play, and a way to change that. Sits beside the
 * favourite button wherever a track is shown on its own — the Now Playing screen and the desktop
 * player bar — so it is obvious at a glance whether the song will play without a connection.
 */
export function OfflineTrackButton({ track, size = "md" }: { track: Track | null; size?: "sm" | "md" | "lg" }) {
  const t = useT();
  const [kept, setKept] = useState(false);

  useEffect(() => {
    let live = true;
    setKept(false);
    if (!track || !offlineSupported()) {
      return;
    }
    void keptIds().then((ids) => {
      if (live) setKept(ids.has(track.id));
    });
    return () => {
      live = false;
    };
  }, [track?.id]);

  if (!offlineSupported() || !track) return null;

  const toggle = async () => {
    try {
      if (kept) {
        await drop(track.id);
        setKept(false);
        toast(t.trackMenu.offlineRemoved(track.title));
      } else {
        await keep(track.id);
        setKept(true);
        toast(t.trackMenu.offlineKept(track.title));
      }
    } catch {
      toast(t.trackMenu.offlineFailed, "error");
    }
  };

  const glyph = size === "lg" ? 24 : size === "sm" ? 16 : 19;

  return (
    <IconButton
      label={kept ? t.trackMenu.offlineRemove : t.trackMenu.offlineKeep}
      active={kept}
      size={size}
      onClick={() => void toggle()}
    >
      {kept ? <CheckCircleIcon size={glyph} weight="fill" /> : <DownloadSimpleIcon size={glyph} />}
    </IconButton>
  );
}
