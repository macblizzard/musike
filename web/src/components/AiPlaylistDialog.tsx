import { CheckCircleIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useT } from "../i18n";
import { api, capabilities } from "../lib/api";
import type { AiJobStage } from "../lib/apiTypes";
import { cn } from "../lib/format";
import { paths } from "../lib/routes";
import type { Playlist } from "../lib/types";
import { usePlayer } from "../player/player";
import { useAi } from "../stores/ai";
import { useLibrary } from "../stores/library";
import { useUi } from "../stores/ui";
import { Modal } from "./Modal";

type Phase = "idle" | "running" | "done" | "error";

const POLL_MS = 1200;
/** Long enough for a slow provider plus a handful of searches. */
const GIVE_UP_MS = 150_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The AI playlist assistant: the person describes what they want, the server's tools find the songs and
 * the finished playlist lands in the library like any other.
 */
export function AiPlaylistDialog() {
  const prompt = useUi((s) => s.aiPrompt);
  const close = useUi((s) => s.closeAi);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const ai = useAi();
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const navigate = useNavigate();
  const t = useT();

  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<AiJobStage>("thinking");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const cancelled = useRef(false);

  const open = prompt !== null;
  const configured = ai.ready();
  const supported = capabilities.ai && !!api.aiPlaylist && !!api.aiJob;

  useEffect(() => {
    if (!open) return;
    cancelled.current = false;
    setText(prompt ?? "");
    setPhase("idle");
    setError("");
    setPlaylist(null);
    setDetail("");
  }, [open, prompt]);

  useEffect(() => () => void (cancelled.current = true), []);

  const start = async () => {
    if (!api.aiPlaylist || !api.aiJob || !text.trim()) return;
    setPhase("running");
    setError("");
    setStage("thinking");
    setDetail("");
    try {
      const { jobId } = await api.aiPlaylist({
        prompt: text.trim(),
        config: ai.config(),
        personalize: ai.personalize,
      });
      const deadline = Date.now() + GIVE_UP_MS;
      while (!cancelled.current && Date.now() < deadline) {
        await sleep(POLL_MS);
        if (cancelled.current) return;
        const job = await api.aiJob(jobId);
        setStage(job.stage);
        setDetail(job.detail);
        if (job.status === "done" && job.playlist) {
          setPlaylist(job.playlist);
          setPhase("done");
          // The library (and the rail's playlist list) picks the new playlist up.
          await useLibrary.getState().load();
          return;
        }
        if (job.status === "error") {
          setError(job.error || t.ai.failed);
          setPhase("error");
          return;
        }
      }
      if (!cancelled.current) {
        setError(t.ai.timeout);
        setPhase("error");
      }
    } catch (e) {
      setError((e as Error).message || t.ai.failed);
      setPhase("error");
    }
  };

  const stageLabel =
    stage === "searching" ? t.ai.stageSearching : stage === "creating" ? t.ai.stageCreating : t.ai.stageThinking;

  const chips: { label: string; prompt: string }[] = [];
  if (current) {
    chips.push({
      label: t.ai.likeThis(current.title),
      prompt: t.ai.likeThisPrompt(current.title, current.artist),
    });
    if (current.artist) {
      const artist = current.artist.split(",")[0]!.trim();
      chips.push({ label: t.ai.bestOf(artist), prompt: t.ai.bestOfPrompt(artist) });
    }
  }
  chips.push(
    { label: t.ai.chipFocus, prompt: t.ai.chipFocusPrompt },
    { label: t.ai.chipChill, prompt: t.ai.chipChillPrompt },
    { label: t.ai.chipWorkout, prompt: t.ai.chipWorkoutPrompt },
  );
  if (ai.personalize) chips.push({ label: t.ai.chipDiscover, prompt: t.ai.chipDiscoverPrompt });

  return (
    <Modal open={open} onClose={close} title={t.ai.title}>
      {!supported ? (
        <p className="text-sm text-fg-2">{t.ai.unavailable}</p>
      ) : !configured ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">{t.ai.needSetup}</p>
          <button
            type="button"
            onClick={() => {
              close();
              setSettingsOpen(true);
            }}
            className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            {t.ai.openSettings}
          </button>
        </div>
      ) : phase === "done" && playlist ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
            <CheckCircleIcon size={22} weight="fill" className="mt-0.5 shrink-0 text-accent-text" />
            <div className="min-w-0">
              <p className="font-semibold">{playlist.name}</p>
              <p className="text-sm text-fg-2">{t.common.tracks(playlist.tracks.length)}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg"
            >
              {t.ai.close}
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                navigate(paths.playlist(playlist.id));
              }}
              className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink transition-transform active:scale-[0.97]"
            >
              {t.ai.open}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label htmlFor="ai-prompt" className="text-sm text-fg-2">
            {t.ai.promptLabel}
          </label>
          <textarea
            id="ai-prompt"
            autoFocus
            rows={3}
            value={text}
            maxLength={600}
            disabled={phase === "running"}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.ai.placeholder}
            className="resize-none rounded-[16px] border border-line-strong bg-surface-1 p-4 text-[15px] placeholder:text-fg-3 focus:border-accent focus:outline-none disabled:opacity-70"
          />

          {phase !== "running" && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => setText(chip.prompt)}
                  className="h-8 rounded-full px-3 text-[13px] text-fg-2 ring-1 ring-line transition-colors hover:text-fg"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {phase === "running" && (
            <div className="flex items-center gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line" aria-live="polite">
              <SparkleIcon size={20} className="shrink-0 animate-pulse text-accent-text" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{stageLabel}</p>
                <p className="truncate text-sm text-fg-2">{detail || t.ai.working}</p>
              </div>
            </div>
          )}

          {phase === "error" && (
            <p className={cn("flex items-start gap-2 text-sm text-danger")}>
              <WarningCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={close}
              className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg"
            >
              {phase === "running" ? t.ai.cancel : t.common.cancel}
            </button>
            <button
              type="button"
              disabled={phase === "running" || !text.trim()}
              onClick={() => void start()}
              className="flex h-11 items-center gap-1.5 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink transition-transform active:scale-[0.97] disabled:opacity-40"
            >
              <SparkleIcon size={17} weight="fill" />
              {phase === "error" ? t.ai.retry : t.ai.generate}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
