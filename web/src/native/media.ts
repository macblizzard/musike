import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { SystemMedia } from "../lib/apiTypes";

/**
 * Bridge to the app's Android side (MusikePlaybackPlugin.java): a foreground service with a media session,
 * so music keeps playing with the screen off and the notification, lock screen and headphone buttons work.
 */
interface PlaybackPlugin {
  update(options: {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
    playing?: boolean;
    position?: number;
    duration?: number;
  }): Promise<void>;
  addListener(event: "action", fn: (e: { action: string; position?: number }) => void): Promise<PluginListenerHandle>;
}

const noop = async () => {};
const Playback = registerPlugin<PlaybackPlugin>("MusikePlayback", {
  // In a desktop browser (development), there is nothing to drive.
  web: () => ({ update: noop, addListener: async () => ({ remove: noop }) }),
});

// The system advances the position on its own while playing; only real changes need sending.
let last = { playing: false, position: 0, at: 0 };

export const media: SystemMedia = {
  setTrack(track) {
    last = { playing: last.playing, position: 0, at: Date.now() };
    void Playback.update({ ...track, position: 0 });
  },
  setState({ playing, position, duration }) {
    const now = Date.now();
    const expected = last.playing ? last.position + (now - last.at) / 1000 : last.position;
    if (playing === last.playing && Math.abs(position - expected) < 2 && now - last.at < 15_000) return;
    last = { playing, position, at: now };
    void Playback.update({ playing, position, duration: Number.isFinite(duration) ? duration : 0 });
  },
  onAction(handler) {
    void Playback.addListener("action", (e) => handler(e.action as Parameters<typeof handler>[0], e.position));
  },
};
