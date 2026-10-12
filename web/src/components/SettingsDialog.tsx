import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  MoonIcon,
  SunIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Channel } from "../lib/api";
import { cn } from "../lib/format";
import { useSystem } from "../stores/system";
import { useUi } from "../stores/ui";
import { BackupSection } from "./BackupSection";
import { Modal } from "./Modal";

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, ReactNode][];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-surface-1 p-1 ring-1 ring-line">
      {options.map(([v, content]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200",
            value === v ? "bg-surface-4 text-fg shadow-[inset_0_1px_0_var(--highlight)]" : "text-fg-2 hover:text-fg",
          )}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

function Dependency({ name, role, path, fix }: { name: string; role: string; path: string | null; fix: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5" title={path ?? undefined}>
      {path ? (
        <CheckCircleIcon size={20} weight="fill" className="shrink-0 text-accent-text" />
      ) : (
        <WarningCircleIcon size={20} weight="fill" className="shrink-0 text-danger" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{name}</span>
        <span className="block text-xs text-fg-2">
          {path ? (
            role
          ) : (
            <>
              Não encontrado. No terminal: <code className="font-mono text-fg">{fix}</code> e reinicie o Musike.
            </>
          )}
        </span>
      </span>
    </li>
  );
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const { info, status, load, update } = useSystem();
  const [channel, setChannel] = useState<Channel>("stable");
  const logBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (info) setChannel(info.ytdlp.channel);
  }, [info?.ytdlp.channel]);

  const job = info?.job;
  const running = job?.status === "running";

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [job?.log.length]);

  const y = info?.ytdlp;
  const missing = !!info && !y?.path;
  const switching = !!y?.version && channel !== y.channel;
  const target = y?.latest[channel];

  let action: string;
  if (running) action = job?.kind === "install" ? "Instalando" : "Atualizando";
  else if (missing) action = "Instalar yt-dlp";
  else if (switching) action = channel === "nightly" ? "Mudar para Nightly" : "Voltar para Estável";
  else if (y?.updateAvailable && target) action = `Atualizar para ${target}`;
  else action = "Verificar e atualizar";

  const chip = !info ? null : missing ? (
    <span className="rounded-full bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger">Não encontrado</span>
  ) : y?.updateAvailable ? (
    <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-text">Atualização disponível</span>
  ) : (
    <span className="rounded-full bg-surface-3 px-2.5 py-1 text-xs font-medium text-fg-2">Atualizado</span>
  );

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Ajustes">
      {/* Side padding keeps outset rings and the scrollbar from clipping the cards' edges. */}
      <div className="scroll-area -mx-2 flex max-h-[70dvh] flex-col gap-5 overflow-y-auto px-2 pb-1">

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-3">Aparência</h3>
          <Segmented
            label="Tema"
            value={theme}
            onChange={setTheme}
            options={[
              ["dark", <><MoonIcon size={15} /> Escuro</>],
              ["light", <><SunIcon size={15} /> Claro</>],
            ]}
          />
        </section>

        <BackupSection />

        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-medium text-fg-3">Motor do YouTube</h3>

          <div className="flex flex-col gap-4 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold tracking-tight">yt-dlp</p>
                <p className="font-mono text-[13px] text-fg-2 tabular-nums">
                  {status === "loading" && !info ? "verificando" : y?.version ?? "sem versão"}
                  {y?.version && <span className="text-fg-3"> · {y.channel === "nightly" ? "nightly" : "estável"}</span>}
                </p>
              </div>
              {chip}
            </div>

            <p className="text-sm text-fg-2">
              É quem busca o áudio e o vídeo no YouTube. O YouTube muda com frequência: se as músicas pararem de tocar, atualize aqui.
            </p>

            {!missing && (
              <div className="flex flex-col gap-1.5">
                <Segmented
                  label="Canal de atualização"
                  value={channel}
                  onChange={setChannel}
                  options={[
                    ["stable", "Estável"],
                    ["nightly", "Nightly"],
                  ]}
                />
                <p className="px-1 text-xs text-fg-3">
                  {channel === "nightly"
                    ? `Recebe correções no mesmo dia em que o YouTube muda.${y?.latest.nightly ? ` Última: ${y.latest.nightly}` : ""}`
                    : `Versões testadas, lançadas a cada poucas semanas.${y?.latest.stable ? ` Última: ${y.latest.stable}` : ""}`}
                </p>
              </div>
            )}

            <button
              type="button"
              disabled={running || !info || (missing && !info.canInstall)}
              onClick={() => void update(channel)}
              className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 font-semibold text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {running ? (
                <ArrowsClockwiseIcon size={20} weight="bold" className="animate-spin" />
              ) : missing ? (
                <DownloadSimpleIcon size={20} weight="bold" />
              ) : (
                <ArrowsClockwiseIcon size={20} weight="bold" />
              )}
              {action}
            </button>

            {missing && info && !info.canInstall && (
              <p className="text-sm text-danger">
                O winget não está disponível. Instale o yt-dlp manualmente e reinicie o Musike.
              </p>
            )}

            {job && (job.status === "running" || Date.now() - (job.finishedAt ?? 0) < 5 * 60_000) && (
              <div className="flex flex-col gap-2">
                {job.status !== "running" && (
                  <p className={cn("text-sm font-medium", job.status === "error" ? "text-danger" : "text-accent-text")}>
                    {job.message}
                  </p>
                )}
                <pre
                  ref={logBox}
                  aria-live="polite"
                  className="max-h-36 overflow-y-auto rounded-[10px] bg-bg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2 scroll-area"
                >
                  {job.log.length ? job.log.join("\n") : "Iniciando"}
                </pre>
              </div>
            )}
          </div>

          {info && (
            <ul className="divide-y divide-line px-1">
              <Dependency name="Deno" role="Resolve os desafios do YouTube" path={info.deno} fix="winget install DenoLand.Deno" />
              <Dependency name="FFmpeg" role="Junta vídeo e áudio no modo HD" path={info.ffmpeg} fix="winget install yt-dlp.FFmpeg" />
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
