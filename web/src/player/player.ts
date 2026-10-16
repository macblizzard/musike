import { create } from "zustand";
import { getT, useT } from "../i18n";
import { api, explainStreamError, streamUrl } from "../lib/api";
import { shuffled } from "../lib/format";
import { read as readOffline } from "../lib/offline";
import type { Track } from "../lib/types";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast } from "../stores/ui";

export type Repeat = "off" | "all" | "one";
/** A code translated where it is shown (so switching languages updates it), or a server error already in the right language. */
export type StatusNote = "findingClip" | "preparingHd" | "loadingVideo" | "fetchingRadio" | { error: string };
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
type Kind = "audio" | "video";
type Quality = "sd" | "hd";

interface PlayerState {
  queue: Track[];
  /** Queue order before shuffle was turned on, restored when it is turned off. */
  original: Track[] | null;
  index: number;
  status: Status;
  /** What playback is busy with (or why it failed), shown instead of the artist. See `useStatusText`. */
  statusText: StatusNote | null;
  /** Which media element is driving playback right now. */
  mediaKind: Kind;
  /** Set when Video mode is on but the current song has no music video on YouTube. */
  videoNote: "noClip" | null;
  /** Intrinsic width/height of the current video, so vertical videos get a vertical stage. */
  videoAspect: number;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;

  playList: (tracks: Track[], start?: number) => void;
  playTrack: (track: Track) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clearUpcoming: () => void;
  startRadio: (track: Track) => Promise<void>;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setPreferVideo: (on: boolean) => void;
  setQuality: (q: Quality) => void;
  setAutoRadio: (on: boolean) => void;
}

// Media elements live outside React so playback survives any re-render or route change.
const audio = new Audio();
audio.preload = "auto";

export const videoEl = document.createElement("video");
videoEl.playsInline = true;
videoEl.preload = "auto";
videoEl.setAttribute("playsinline", "");
videoEl.className = "block h-full w-full object-contain bg-black";

const mediaFor = (k: Kind): HTMLMediaElement => (k === "video" ? videoEl : audio);

/**
 * Hand-off warm-up.
 *
 * iOS suspends a backgrounded PWA the moment nothing is playing and only wakes it up seconds
 * (or minutes) later. A hand-off that waits for `ended` and then issues a fresh media request
 * therefore never lands on time: the previous track stops, the page is suspended, and the next
 * one only starts when iOS wakes the app again — the long silent gap between songs. So the
 * next track's audio is fetched while the current one still plays, and playback moves over
 * just before this one ends, leaving no moment without audio.
 */
const HANDOFF_LEAD_SECONDS = 0.5;
/** Longer than this the file is too big to hold in memory; those stream as usual. */
const WARM_MAX_SECONDS = 900;
const WARM_KEEP = 3;

const warmBlobs = new Map<string, string>();
const warmJobs = new Map<string, Promise<string>>();

/** Fetches a track's audio up front and returns a local URL for it. */
export function warmTrack(id: string, duration: number): void {
  if (!id || duration > WARM_MAX_SECONDS || warmBlobs.has(id) || warmJobs.has(id)) return;
  const job = fetch(streamUrl(id, "audio", "sd"), { headers: { Range: "bytes=0-" } })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`stream ${res.status}`))))
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      warmBlobs.set(id, url);
      trimWarm();
      return url;
    })
    .catch(() => "")
    .finally(() => warmJobs.delete(id));
  warmJobs.set(id, job);
}

/** The warmed local URL for a track, when it is already in memory. */
const warmUrl = (id: string): string | undefined => warmBlobs.get(id);

/**
 * An object URL for a kept track's audio. Only the current one is retained; the previous is
 * released on a delay, once nothing can still be pointing a media element at it.
 */
let offlineLocal: { id: string; url: string } | null = null;

function offlineUrl(id: string, blob: Blob): string {
  if (offlineLocal?.id === id) return offlineLocal.url;
  const url = URL.createObjectURL(blob);
  const previous = offlineLocal;
  offlineLocal = { id, url };
  if (previous) setTimeout(() => URL.revokeObjectURL(previous.url), 15_000);
  return url;
}

/** Drops old warmed tracks, never revoking the one playing or the one about to play. */
function trimWarm() {
  if (warmBlobs.size <= WARM_KEEP) return;
  const s = usePlayer.getState();
  const keep = new Set([s.queue[s.index]?.id, s.queue[s.index + 1]?.id]);
  for (const [id, url] of warmBlobs) {
    if (warmBlobs.size <= WARM_KEEP) break;
    if (keep.has(id)) continue;
    URL.revokeObjectURL(url);
    warmBlobs.delete(id);
  }
}

let loaded: { id: string; kind: Kind; quality: Quality } | null = null;
let pendingSeek = 0;
let token = 0;
let recordedToken = -1;
let handoffFor = -1;

const STORAGE_KEY = "musike:player";

interface Saved {
  queue: Track[];
  original: Track[] | null;
  index: number;
  position: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;
}

function readSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}

const saved = readSaved();

/**
 * Songs from YouTube Music are "art tracks": audio with a still cover. In Video mode we play the
 * song's music video instead. Song id → video id, or null when YouTube has no clip for it.
 */
const clipFor = new Map<string, string | null>();
const clipLookups = new Map<string, Promise<string | null>>();

function lookupClip(track: Track): Promise<string | null> {
  if (track.kind === "video") return Promise.resolve(track.id);
  if (clipFor.has(track.id)) return Promise.resolve(clipFor.get(track.id)!);
  let lookup = clipLookups.get(track.id);
  if (!lookup) {
    lookup = api
      .videoFor(track)
      .then(
        (v) => {
          const id = v?.id ?? null;
          clipFor.set(track.id, id);
          return id;
        },
        () => null, // network hiccup: don't remember it, try again next time
      )
      .finally(() => clipLookups.delete(track.id));
    clipLookups.set(track.id, lookup);
  }
  return lookup;
}

const needsClipLookup = (track: Track, preferVideo: boolean) =>
  preferVideo && track.kind === "song" && !clipFor.has(track.id);

export const usePlayer = create<PlayerState>((set, get) => {
  const kindFor = (track: Track): Kind =>
    get().preferVideo && (track.kind === "video" || !!clipFor.get(track.id)) ? "video" : "audio";
  /** The YouTube id to stream: the song itself, or its music video in Video mode. */
  const mediaIdFor = (track: Track, kind: Kind) =>
    kind === "video" && track.kind !== "video" ? clipFor.get(track.id)! : track.id;
  const noteFor = (track: Track) =>
    get().preferVideo && track.kind === "song" && clipFor.get(track.id) === null ? ("noClip" as const) : null;
  const activeMedia = (): HTMLMediaElement | null => (loaded ? mediaFor(loaded.kind) : null);

  function play(media: HTMLMediaElement) {
    media.play().catch((err: DOMException) => {
      if (err.name === "AbortError") return; // src changed mid-start
      if (err.name === "NotAllowedError") set({ status: "paused" }); // autoplay blocked
    });
  }

  async function load(index: number, opts: { autoplay?: boolean; startAt?: number } = {}) {
    const s = get();
    const track = s.queue[index];
    if (!track) return;

    // Video mode on a song: find its music video first, then load whichever fits.
    if (needsClipLookup(track, s.preferVideo)) {
      const mine = ++token;
      set({
        index,
        status: "loading",
        statusText: "findingClip",
        videoNote: null,
        position: opts.startAt ?? 0,
        duration: track.duration,
        buffered: 0,
      });
      activeMedia()?.pause();
      setMetadata(track);
      void lookupClip(track).then(() => {
        if (mine === token) void load(index, opts);
      });
      return;
    }

    const kind = kindFor(track);
    const mediaId = mediaIdFor(track, kind);

    // A track kept for offline play is read from storage first: no network involved, and the media
    // element receives the whole file at once, so seeking never needs a byte-range round trip.
    // `token` is only bumped after the read, so a track change meanwhile wins.
    let local: string | undefined = kind === "audio" ? warmUrl(mediaId) : undefined;
    if (kind === "audio" && !local) {
      const mine = token;
      try {
        const blob = await readOffline(mediaId);
        if (mine !== token) return;
        if (blob) local = offlineUrl(mediaId, blob);
      } catch {
        /* storage unavailable: stream it instead */
      }
    }

    const media = mediaFor(kind);
    const other = mediaFor(kind === "video" ? "audio" : "video");
    other.pause();
    if (other.getAttribute("src")) {
      other.removeAttribute("src");
      other.load();
    }

    const live = get();
    token++;
    loaded = { id: track.id, kind, quality: live.quality };
    pendingSeek = opts.startAt ?? 0;
    const autoplay = opts.autoplay !== false;
    set({
      index,
      mediaKind: kind,
      status: autoplay ? "loading" : "paused",
      // Video may need a server-side download first (HD, or videos without a combined SD stream).
      statusText: kind === "video" ? (live.quality === "hd" ? "preparingHd" : "loadingVideo") : null,
      videoNote: noteFor(track),
      position: pendingSeek,
      duration: track.duration,
      buffered: 0,
    });
    media.volume = live.volume;
    media.muted = live.muted;
    // A warmed or kept track is already local, so starting it touches no network at all.
    media.src = local ?? streamUrl(mediaId, kind, live.quality);
    if (autoplay) play(media);
    setMetadata(track);
  }

  /**
   * Moves to the next track just before this one ends, while audio is still playing. Waiting
   * for `ended` is what breaks background playback on iOS: with nothing playing the page gets
   * suspended, so the hand-off only runs when iOS wakes the app again — which is the long
   * silent gap people hear between songs. The next track is already in memory (`warmTrack`),
   * so the switch costs nothing.
   *
   * Only while the page is hidden: that is when iOS suspends it. With the app on screen the
   * track is left to finish naturally — the warmed next track makes the `ended` hand-off
   * immediate anyway — so nothing is cut short for someone watching the player.
   */
  function handOffBeforeEnd(media: HTMLMediaElement) {
    if (document.visibilityState !== "hidden") return;
    const s = get();
    if (s.repeat === "one" || handoffFor === token || s.index >= s.queue.length - 1) return;
    if (!Number.isFinite(media.duration) || media.duration <= 0) return;
    if (media.duration - media.currentTime > HANDOFF_LEAD_SECONDS) return;
    const next = s.queue[s.index + 1];
    if (!next || !warmUrl(next.id)) return;
    handoffFor = token;
    load(s.index + 1);
  }

  async function continueWithRadio() {
    const s = get();
    const last = s.queue[s.index];
    if (!last) return;
    set({ status: "loading", statusText: "fetchingRadio" });
    try {
      const known = new Set(get().queue.map((t) => t.id));
      const more = (await api.radio(last.id)).filter((t) => !known.has(t.id)).slice(0, 25);
      if (!more.length) throw new Error("empty");
      set((st) => ({
        queue: [...st.queue, ...more],
        original: st.original ? [...st.original, ...more] : null,
      }));
      toast(getT().player.radioContinuing(last.title));
      load(get().index + 1);
    } catch {
      set({ status: "paused", statusText: null, position: 0 });
    }
  }

  function onStarted() {
    const s = get();
    const track = s.queue[s.index];
    if (!track || recordedToken === token) return;
    recordedToken = token;
    useLibrary.getState().recordPlay(track);
    // Warm up the next track (and, in Video mode, find and resolve its clip) so it starts quickly.
    const upcoming = s.queue[s.index + 1];
    if (!upcoming) return;
    if (s.preferVideo) void lookupClip(upcoming).then((id) => api.prepare(id ?? upcoming.id).catch(() => {}));
    else {
      api.prepare(upcoming.id).catch(() => {});
      // Pull the bytes now, while playback (and therefore the page) is still alive.
      warmTrack(upcoming.id, upcoming.duration);
    }
  }

  function onEnded() {
    const s = get();
    if (s.repeat === "one") {
      const media = activeMedia();
      if (media) {
        media.currentTime = 0;
        play(media);
      }
      return;
    }
    if (s.index < s.queue.length - 1) return load(s.index + 1);
    if (s.repeat === "all" && s.queue.length) return load(0);
    if (s.autoRadio) return void continueWithRadio();
    set({ status: "paused", position: 0 });
  }

  function onError(media: HTMLMediaElement) {
    const mine = token;
    const url = media.currentSrc || media.src;
    set({ status: "error" });
    explainStreamError(url).then(({ message, code }) => {
      if (mine !== token) return;
      set({ statusText: { error: message } });
      const track = get().queue[get().index];
      // Tool problems hit every track: offer the fix instead of skipping through the whole queue.
      const toolProblem = code === "tool_missing" || code === "maybe_outdated";
      const t = getT();
      toast(
        t.player.cantPlay(track?.title ?? t.player.aTrack, message),
        "error",
        toolProblem ? { label: code === "tool_missing" ? t.common.install : t.common.update, run: openSettings } : undefined,
      );
      if (code !== "tool_missing" && get().index < get().queue.length - 1) {
        setTimeout(() => mine === token && get().next(), 2500);
      }
    });
  }

  function wire(media: HTMLMediaElement) {
    const isActive = () => activeMedia() === media;
    media.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      if (pendingSeek > 0) {
        media.currentTime = pendingSeek;
        pendingSeek = 0;
      }
      if (Number.isFinite(media.duration)) set({ duration: media.duration });
      if (media === videoEl && videoEl.videoWidth && videoEl.videoHeight) {
        set({ videoAspect: videoEl.videoWidth / videoEl.videoHeight });
      }
      syncPositionState();
    });
    media.addEventListener("durationchange", () => {
      if (isActive() && Number.isFinite(media.duration)) set({ duration: media.duration });
    });
    media.addEventListener("playing", () => {
      if (!isActive()) return;
      set({ status: "playing", statusText: null });
      onStarted();
      syncPlaybackState();
    });
    media.addEventListener("pause", () => {
      if (!isActive() || media.ended || get().status === "loading" || get().status === "error") return;
      set({ status: "paused" });
      syncPlaybackState();
    });
    media.addEventListener("waiting", () => {
      if (isActive() && !media.paused) set({ status: "loading" });
    });
    media.addEventListener("timeupdate", () => {
      if (!isActive() || pendingSeek > 0) return;
      if (Math.abs(media.currentTime - get().position) >= 0.2) set({ position: media.currentTime });
      handOffBeforeEnd(media);
    });
    media.addEventListener("progress", () => {
      if (!isActive() || !media.buffered.length) return;
      set({ buffered: media.buffered.end(media.buffered.length - 1) });
    });
    media.addEventListener("seeked", () => isActive() && syncPositionState());
    media.addEventListener("ended", () => isActive() && onEnded());
    media.addEventListener("error", () => isActive() && media.getAttribute("src") && onError(media));
  }
  wire(audio);
  wire(videoEl);

  const reloadIfKindChanged = () => {
    const s = get();
    const track = s.queue[s.index];
    if (!track) return;
    set({ videoNote: noteFor(track) });
    if (!loaded || loaded.id !== track.id) return;
    const wasPlaying = s.status === "playing" || s.status === "loading";
    if (needsClipLookup(track, s.preferVideo)) return load(s.index, { startAt: s.position, autoplay: wasPlaying });
    const kind = kindFor(track);
    if (loaded.kind === kind && (kind === "audio" || loaded.quality === s.quality)) return;
    load(s.index, { startAt: s.position, autoplay: wasPlaying });
  };

  return {
    queue: saved.queue ?? [],
    original: saved.original ?? null,
    index: saved.index ?? 0,
    status: saved.queue?.length ? "paused" : "idle",
    statusText: null,
    mediaKind: "audio",
    videoNote: null,
    videoAspect: 16 / 9,
    position: saved.position ?? 0,
    duration: saved.queue?.[saved.index ?? 0]?.duration ?? 0,
    buffered: 0,
    volume: saved.volume ?? 0.9,
    muted: saved.muted ?? false,
    shuffle: saved.shuffle ?? false,
    repeat: saved.repeat ?? "off",
    preferVideo: saved.preferVideo ?? false,
    quality: saved.quality ?? "sd",
    autoRadio: saved.autoRadio ?? true,

    playList: (tracks, start = 0) => {
      if (!tracks.length) return;
      const first = tracks[start] ?? tracks[0];
      if (get().shuffle) {
        const rest = tracks.filter((_, i) => i !== start);
        set({ queue: [first, ...shuffled(rest)], original: tracks.slice() });
        load(0);
      } else {
        set({ queue: tracks.slice(), original: null });
        load(start);
      }
    },

    playTrack: (track) => {
      const s = get();
      const at = s.queue.findIndex((t) => t.id === track.id);
      if (at >= 0) return load(at);
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      load(insert);
    },

    playNext: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      toast(getT().player.playsNext(track.title));
    },

    addToQueue: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      set({ queue: [...s.queue, track], original: s.original ? [...s.original, track] : null });
      toast(getT().player.addedToQueue(track.title));
    },

    removeAt: (i) => {
      const s = get();
      if (i < 0 || i >= s.queue.length) return;
      const removed = s.queue[i];
      const queue = s.queue.filter((_, j) => j !== i);
      const original = s.original?.filter((t) => t !== removed) ?? null;
      if (i < s.index) return set({ queue, original, index: s.index - 1 });
      if (i > s.index) return set({ queue, original });
      // Removing the current track: move on to whatever takes its place.
      set({ queue, original });
      if (queue[i]) load(i, { autoplay: s.status === "playing" });
      else {
        activeMedia()?.pause();
        loaded = null;
        set({ index: Math.max(0, queue.length - 1), status: queue.length ? "paused" : "idle", position: 0 });
      }
    },

    jumpTo: (i) => load(i),

    clearUpcoming: () => {
      const s = get();
      const keep = s.queue.slice(0, s.index + 1);
      set({ queue: keep, original: s.original ? keep.slice() : null });
    },

    startRadio: async (track) => {
      toast(getT().player.startingRadio(track.title));
      try {
        const related = await api.radio(track.id);
        get().playList([track, ...related.filter((t) => t.id !== track.id)], 0);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },

    toggle: () => {
      const s = get();
      const track = s.queue[s.index];
      if (!track) return;
      const kind = kindFor(track);
      const stale =
        !loaded ||
        loaded.id !== track.id ||
        loaded.kind !== kind ||
        (kind === "video" && loaded.quality !== s.quality) ||
        needsClipLookup(track, s.preferVideo);
      if (stale || s.status === "error") return load(s.index, { startAt: s.position });
      const media = mediaFor(kind);
      if (media.paused) play(media);
      else media.pause();
    },

    next: () => {
      const s = get();
      if (s.index < s.queue.length - 1) return load(s.index + 1);
      if (s.repeat === "all" && s.queue.length) return load(0);
      if (s.autoRadio) void continueWithRadio();
    },

    prev: () => {
      const s = get();
      if (s.position > 3 || s.index === 0) return get().seek(0);
      load(s.index - 1);
    },

    seek: (seconds) => {
      const t = Math.max(0, Math.min(seconds, get().duration || seconds));
      set({ position: t });
      const media = activeMedia();
      const track = get().queue[get().index];
      if (!media || !track || loaded?.id !== track.id || media.readyState === 0) {
        pendingSeek = t;
        return;
      }
      media.currentTime = t;
    },

    setVolume: (v) => {
      const volume = Math.max(0, Math.min(1, v));
      audio.volume = videoEl.volume = volume;
      const muted = volume === 0 ? true : false;
      audio.muted = videoEl.muted = muted;
      set({ volume, muted });
    },

    toggleMute: () => {
      const muted = !get().muted;
      audio.muted = videoEl.muted = muted;
      if (!muted && get().volume === 0) get().setVolume(0.6);
      else set({ muted });
    },

    toggleShuffle: () => {
      const s = get();
      const current = s.queue[s.index];
      if (!s.shuffle) {
        const rest = s.queue.filter((_, i) => i !== s.index);
        set({ shuffle: true, original: s.queue, queue: current ? [current, ...shuffled(rest)] : shuffled(rest), index: 0 });
        return;
      }
      const present = new Set(s.queue);
      const base = (s.original ?? s.queue).filter((t) => present.has(t));
      const extra = s.queue.filter((t) => !base.includes(t));
      const queue = [...base, ...extra];
      set({ shuffle: false, original: null, queue, index: Math.max(0, current ? queue.indexOf(current) : 0) });
    },

    cycleRepeat: () => {
      const order: Repeat[] = ["off", "all", "one"];
      set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
    },

    setPreferVideo: (on) => {
      set({ preferVideo: on });
      reloadIfKindChanged();
    },

    setQuality: (quality) => {
      set({ quality });
      reloadIfKindChanged();
    },

    setAutoRadio: (autoRadio) => set({ autoRadio }),
  };
});

audio.volume = videoEl.volume = usePlayer.getState().volume;
audio.muted = videoEl.muted = usePlayer.getState().muted;

export const selectCurrent = (s: PlayerState): Track | null => s.queue[s.index] ?? null;

/** Whether the track can be shown as video (art tracks are audio with a still image). */

// Persistence: resume the same queue and position after a reload.

function persist() {
  const s = usePlayer.getState();
  const data: Saved = {
    queue: s.queue.slice(0, 500),
    original: s.original?.slice(0, 500) ?? null,
    index: s.index,
    position: s.position,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    preferVideo: s.preferVideo,
    quality: s.quality,
    autoRadio: s.autoRadio,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked */
  }
}
setInterval(persist, 4000);
addEventListener("pagehide", persist);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && persist());

// Media Session: lock-screen, headset and notification controls.

function setMetadata(track: Track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    artwork:
      track.kind === "video"
        ? [
            { src: track.art, sizes: "1280x720", type: "image/jpeg" },
            { src: track.thumb, sizes: "320x180", type: "image/jpeg" },
          ]
        : [{ src: track.art, sizes: "544x544", type: "image/jpeg" }],
  });
}

function syncPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = usePlayer.getState().status === "playing" ? "playing" : "paused";
  syncPositionState();
}

function syncPositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const { duration, position } = usePlayer.getState();
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 });
  } catch {
    /* some browsers reject transient states */
  }
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const p = () => usePlayer.getState();
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => p().status !== "playing" && p().toggle()],
    ["pause", () => p().status === "playing" && p().toggle()],
    ["previoustrack", () => p().prev()],
    ["nexttrack", () => p().next()],
    ["seekto", (d) => d.seekTime != null && p().seek(d.seekTime)],
    ["seekbackward", (d) => p().seek(p().position - (d.seekOffset ?? 10))],
    ["seekforward", (d) => p().seek(p().position + (d.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      /* action not supported */
    }
  }
  const restored = selectCurrent(usePlayer.getState());
  if (restored) setMetadata(restored);
}

/** The player's status line in the current language, or null when there is nothing to say. */
export function useStatusText(): string | null {
  const note = usePlayer((s) => s.statusText);
  const t = useT();
  if (note === null) return null;
  return typeof note === "string" ? t.player.status[note] : note.error;
}
