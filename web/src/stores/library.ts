import { create } from "zustand";
import { api } from "../lib/api";
import type { Library, Playlist, Track } from "../lib/types";
import { toast } from "./ui";

interface LibraryState extends Library {
  status: "idle" | "loading" | "ready" | "error";
  load: () => Promise<void>;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (t: Track) => Promise<void>;
  recordPlay: (t: Track) => void;
  createPlaylist: (name: string, tracks?: Track[]) => Promise<Playlist | null>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, t: Track) => Promise<void>;
  removeFromPlaylist: (id: string, trackId: string) => Promise<void>;
}

const replacePlaylist = (list: Playlist[], p: Playlist) => list.map((x) => (x.id === p.id ? p : x));

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: [],
  playlists: [],
  history: [],
  status: "idle",

  load: async () => {
    set({ status: "loading" });
    try {
      const lib = await api.library();
      set({ ...lib, status: "ready" });
    } catch {
      set({ status: "error" });
    }
  },

  isFavorite: (id) => get().favorites.some((t) => t.id === id),

  toggleFavorite: async (track) => {
    const prev = get().favorites;
    const on = !prev.some((t) => t.id === track.id);
    // Optimistic: the heart responds instantly, then reconciles with the server.
    set({ favorites: on ? [track, ...prev] : prev.filter((t) => t.id !== track.id) });
    try {
      const { favorites } = on ? await api.addFavorite(track) : await api.removeFavorite(track.id);
      set({ favorites });
      toast(on ? "Adicionada às Favoritas" : "Removida das Favoritas");
    } catch (e) {
      set({ favorites: prev });
      toast((e as Error).message, "error");
    }
  },

  recordPlay: (track) => {
    set((s) => ({ history: [track, ...s.history.filter((t) => t.id !== track.id)].slice(0, 60) }));
    api.pushHistory(track).catch(() => {});
  },

  createPlaylist: async (name, tracks = []) => {
    try {
      const p = await api.createPlaylist(name, tracks);
      set((s) => ({ playlists: [p, ...s.playlists] }));
      toast(`Playlist "${p.name}" criada`);
      return p;
    } catch (e) {
      toast((e as Error).message, "error");
      return null;
    }
  },

  renamePlaylist: async (id, name) => {
    try {
      const p = await api.renamePlaylist(id, name);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  deletePlaylist: async (id) => {
    const prev = get().playlists;
    set({ playlists: prev.filter((p) => p.id !== id) });
    try {
      await api.deletePlaylist(id);
      toast("Playlist excluída");
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },

  addToPlaylist: async (id, track) => {
    try {
      const p = await api.addToPlaylist(id, track);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
      toast(`Adicionada a "${p.name}"`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  removeFromPlaylist: async (id, trackId) => {
    const prev = get().playlists;
    set({
      playlists: prev.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p)),
    });
    try {
      const p = await api.removeFromPlaylist(id, trackId);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },
}));
