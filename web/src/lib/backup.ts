import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";
import { useUi } from "../stores/ui";
import { api, type ImportResult } from "./api";
import type { Library } from "./types";

/**
 * Portable backup of a Musike instance: the library plus a few preferences.
 * Version 1 is read by every Musike from this release on; bump `version` only for breaking changes.
 */
export interface Backup {
  format: "musike-backup";
  version: 1;
  exportedAt: string;
  app: string;
  library: Library;
  settings?: {
    theme?: "dark" | "light";
    preferVideo?: boolean;
    quality?: "sd" | "hd";
    autoRadio?: boolean;
    volume?: number;
  };
}

export async function createBackup(): Promise<Backup> {
  const library = await api.library();
  const p = usePlayer.getState();
  return {
    format: "musike-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    app: `Musike ${__APP_VERSION__}`,
    library: { favorites: library.favorites, playlists: library.playlists, history: library.history },
    settings: {
      theme: useUi.getState().theme,
      preferVideo: p.preferVideo,
      quality: p.quality,
      autoRadio: p.autoRadio,
      volume: p.volume,
    },
  };
}

/** Saves the backup as a file (browsers download it; the desktop app shows a "Save as" dialog). */
export function downloadBackup(backup: Backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `musike-backup-${backup.exportedAt.slice(0, 10)}.musike.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readBackup(file: File): Promise<Backup> {
  let data: Partial<Backup>;
  try {
    data = JSON.parse(await file.text()) as Partial<Backup>;
  } catch {
    throw new Error("Não foi possível ler o arquivo. Ele precisa ser um backup .musike.json.");
  }
  if (data?.format !== "musike-backup" || !data.library) throw new Error("Este arquivo não é um backup do Musike.");
  if (typeof data.version !== "number" || data.version > 1) {
    throw new Error("Backup feito por uma versão mais nova do Musike. Atualize o app para importar.");
  }
  return data as Backup;
}

export function summarize(backup: Backup) {
  const lib = backup.library;
  const playlists = Array.isArray(lib.playlists) ? lib.playlists : [];
  return {
    playlists: playlists.length,
    playlistTracks: playlists.reduce((n, p) => n + (Array.isArray(p.tracks) ? p.tracks.length : 0), 0),
    favorites: Array.isArray(lib.favorites) ? lib.favorites.length : 0,
    history: Array.isArray(lib.history) ? lib.history.length : 0,
    exportedAt: new Date(backup.exportedAt),
  };
}

export async function restoreBackup(backup: Backup, mode: "merge" | "replace", applySettings: boolean): Promise<ImportResult> {
  const result = await api.importLibrary(backup, mode);
  const s = backup.settings;
  if (applySettings && s) {
    const player = usePlayer.getState();
    if (s.theme === "dark" || s.theme === "light") useUi.getState().setTheme(s.theme);
    if (typeof s.autoRadio === "boolean") player.setAutoRadio(s.autoRadio);
    if (typeof s.volume === "number") player.setVolume(s.volume);
    if (s.quality === "sd" || s.quality === "hd") player.setQuality(s.quality);
    if (typeof s.preferVideo === "boolean") player.setPreferVideo(s.preferVideo);
  }
  await useLibrary.getState().load();
  return result;
}
