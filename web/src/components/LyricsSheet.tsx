import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { api, type Lyrics } from "../lib/api";
import { usePlayer } from "../player/player";
import { useUi } from "../stores/ui";
import { Modal } from "./Modal";

/** `[mm:ss.xx] line` — lrclib's timed format. Metadata tags like `[ar:…]` fail the numeric match. */
const TIME_TAG = /^\[(\d+):(\d+(?:[.,]\d+)?)\](.*)$/;

function parseSynced(lrc: string): { at: number; text: string }[] {
  const lines: { at: number; text: string }[] = [];
  for (const raw of lrc.split("\n")) {
    const m = TIME_TAG.exec(raw.trim());
    if (!m) continue;
    const text = m[3].trim();
    if (text) lines.push({ at: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return lines;
}

/**
 * The lyrics of the playing track, from lrclib. When it has them timed, the current line is
 * highlighted and kept in view as the song plays; otherwise the words scroll as plain text.
 */
export function LyricsSheet() {
  const track = useUi((s) => s.lyricsFor);
  const close = useUi((s) => s.openLyrics);
  const position = usePlayer((s) => s.position);
  const t = useT();
  const [data, setData] = useState<Lyrics | null>(null);
  const [status, setStatus] = useState<"loading" | "done" | "error">("done");
  const [nonce, setNonce] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!track) {
      setData(null);
      return;
    }
    let live = true;
    setData(null);
    setStatus("loading");
    api
      .lyrics(track)
      .then((r) => {
        if (!live) return;
        setData(r);
        setStatus("done");
      })
      .catch(() => {
        if (live) setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [track?.id, nonce]);

  const lines = useMemo(() => (data?.synced ? parseSynced(data.synced) : []), [data?.synced]);
  const active = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].at <= position + 0.15) idx = i;
      else break;
    }
    return idx;
  }, [lines, position]);

  // Keep the line being sung in the middle of the sheet, inside this box only.
  useEffect(() => {
    const box_ = box.current;
    const el = box_?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!box_ || !el || active < 0) return;
    box_.scrollTo({ top: el.offsetTop - box_.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [active]);

  return (
    <Modal open={!!track} onClose={() => close(null)} title={t.lyrics.title}>
      <div ref={box} className="scroll-area max-h-[60vh] min-h-[12rem] overflow-y-auto">
        {status === "loading" && <p className="py-10 text-center text-sm text-fg-3">{t.lyrics.loading}</p>}

        {status === "error" && <p className="py-10 text-center text-sm text-fg-3">{t.lyrics.failed}</p>}

        {status === "done" && data && !data.found && data.unavailable && (
          <div className="py-10 text-center">
            <p className="text-sm font-medium">{t.lyrics.busy}</p>
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="mt-3 h-9 rounded-full bg-surface-3 px-4 text-[13px] font-medium transition-colors hover:bg-surface-4"
            >
              {t.lyrics.retry}
            </button>
          </div>
        )}

        {status === "done" && data && !data.found && !data.unavailable && (
          <div className="py-10 text-center">
            <p className="text-sm font-medium">{t.lyrics.none}</p>
            <p className="mt-1 text-xs text-fg-3">{t.lyrics.noneBody}</p>
          </div>
        )}

        {status === "done" && data?.found && !data.plain && !data.synced && (
          <p className="py-10 text-center text-sm text-fg-3">{t.lyrics.instrumental}</p>
        )}

        {status === "done" && lines.length > 0 && (
          <div className="flex flex-col gap-3 py-2">
            {lines.map((line, i) => (
              <p
                key={`${line.at}-${i}`}
                data-line={i}
                className={
                  i === active
                    ? "text-[15px] leading-snug font-semibold text-accent-text transition-colors"
                    : "text-[15px] leading-snug text-fg-3 transition-colors"
                }
              >
                {line.text}
              </p>
            ))}
          </div>
        )}

        {status === "done" && lines.length === 0 && data?.plain && (
          <p className="py-2 text-[15px] leading-relaxed whitespace-pre-line text-fg-2">{data.plain}</p>
        )}
      </div>

      {status === "done" && data?.found && (
        <p className="mt-3 text-right text-[11px] text-fg-3">
          {t.lyrics.from}
          {data.track && data.artist ? ` · ${data.artist} — ${data.track}` : ""}
        </p>
      )}
    </Modal>
  );
}
