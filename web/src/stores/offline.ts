import { create } from "zustand";
import { getT } from "../i18n";
import { drop, dropAll, keep, keptIds, keptTracks, usage } from "../lib/offline";
import type { Track } from "../lib/types";
import { useLibrary } from "./library";
import { toast } from "./ui";

interface OfflineState {
  /** Ids held for offline play. */
  ids: Set<string>;
  /** Their tracks, newest first — what the Downloaded collection shows. */
  tracks: Track[];
  bytes: number;
  ready: boolean;
  /** Re-reads storage. Called on start, when Settings opens, and after every change. */
  refresh: () => Promise<void>;
  /** Keeps or releases one track, with the toast. */
  toggle: (track: Track) => Promise<void>;
  /** Releases everything. */
  clear: () => Promise<void>;
}

/**
 * Who is held for offline play, kept in one place so every surface agrees: the player buttons, the
 * track menu, the Downloaded collection and the storage readout all read from here.
 */
export const useOffline = create<OfflineState>((set, get) => ({
  ids: new Set<string>(),
  tracks: [],
  bytes: 0,
  ready: false,

  refresh: async () => {
    const [ids, tracks, counts] = await Promise.all([keptIds(), keptTracks(), usage()]);
    // A track kept before its metadata was stored is filled in from the library, so it still lists.
    const lib = useLibrary.getState();
    const known = new Map<string, Track>();
    for (const list of [lib.favorites, lib.history, ...lib.playlists.map((p) => p.tracks)]) {
      for (const track of list) known.set(track.id, track);
    }
    const listed = new Set(tracks.map((t) => t.id));
    const recovered = [...ids]
      .filter((id) => !listed.has(id))
      .map((id) => known.get(id))
      .filter((track): track is Track => !!track);
    set({ ids, tracks: [...tracks, ...recovered], bytes: counts.bytes, ready: true });
  },

  toggle: async (track) => {
    const t = getT();
    try {
      if (get().ids.has(track.id)) {
        await drop(track.id);
        await get().refresh();
        toast(t.trackMenu.offlineRemoved(track.title));
      } else {
        await keep(track);
        await get().refresh();
        toast(t.trackMenu.offlineKept(track.title));
      }
    } catch {
      toast(t.trackMenu.offlineFailed, "error");
    }
  },

  clear: async () => {
    await dropAll();
    await get().refresh();
    toast(getT().settings.downloadsCleared);
  },
}));
