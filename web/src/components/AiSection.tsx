import { ArrowsClockwiseIcon, CheckCircleIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { AI_PROVIDERS, useAi } from "../stores/ai";

const field =
  "h-11 w-full rounded-[12px] border border-line-strong bg-bg px-3 text-[14px] placeholder:text-fg-3 focus:border-accent focus:outline-none";

/** Same switch the layout settings use, kept local so this section doesn't depend on that file. */
function SwitchRow({
  label,
  body,
  checked,
  onChange,
}: {
  label: string;
  body?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-2.5">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {body && <span className="block text-xs text-fg-2">{body}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-accent",
          checked ? "bg-accent" : "bg-surface-4",
        )}
      >
        <span
          className={cn(
            "absolute top-1 left-1 size-4 rounded-full transition-transform duration-200 ease-out-expo",
            checked ? "translate-x-4 bg-accent-ink" : "bg-fg-2",
          )}
        />
      </span>
    </label>
  );
}

/**
 * The AI playlist assistant's provider settings. They live on this device only: the server just forwards a
 * request, so the key never leaves this browser or phone.
 */
export function AiSection() {
  const t = useT();
  const ai = useAi();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; message: string }>({
    state: "idle",
    message: "",
  });

  const canLoad = !!ai.baseUrl && /^https?:\/\/.+/.test(ai.baseUrl) && !!api.aiModels;

  const loadModels = async () => {
    if (!api.aiModels || !canLoad) return;
    setLoading(true);
    setListError("");
    try {
      const list = await api.aiModels(ai.config());
      setModels(list);
      // Nothing chosen yet (or the old choice vanished): pick something usable.
      if (list.length && !list.includes(ai.model)) ai.set({ model: list[0]! });
      if (!list.length) setListError(t.settings.aiModelsFailed);
    } catch (e) {
      setListError((e as Error).message || t.settings.aiModelsFailed);
    } finally {
      setLoading(false);
    }
  };

  // Load the list as soon as there is an endpoint and a key: the person should not have to find the refresh icon.
  useEffect(() => {
    if (!canLoad || !ai.apiKey) return;
    const timer = setTimeout(() => void loadModels(), 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.baseUrl, ai.apiKey, canLoad]);

  const runTest = async () => {
    if (!api.aiTest || !ai.model) return;
    setTest({ state: "running", message: "" });
    try {
      const { reply } = await api.aiTest(ai.config());
      setTest({ state: "ok", message: reply || t.settings.aiTestOk });
    } catch (e) {
      setTest({ state: "error", message: (e as Error).message || t.settings.aiTestFailed("") });
    }
  };

  const provider = AI_PROVIDERS.find((p) => p.id === ai.provider) ?? AI_PROVIDERS[0];

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
        <SparkleIcon size={14} /> {t.settings.ai}
      </h3>

      <div className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
        <SwitchRow label={t.settings.aiEnabled} checked={ai.enabled} onChange={(v) => ai.set({ enabled: v })} />
        <p className="text-sm text-fg-2">{t.settings.aiBody}</p>

        <div role="radiogroup" aria-label={t.settings.aiProvider} className="flex rounded-full bg-bg p-1 ring-1 ring-line">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={ai.provider === p.id}
              onClick={() =>
                ai.set({ provider: p.id, baseUrl: p.baseUrl || ai.baseUrl, model: p.defaultModel || ai.model })
              }
              className={cn(
                "h-9 flex-1 rounded-full px-3 text-[13px] font-medium transition-colors",
                ai.provider === p.id ? "bg-surface-4 text-fg shadow-[inset_0_1px_0_var(--highlight)]" : "text-fg-2 hover:text-fg",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-fg-2">{t.settings.aiBaseUrl}</span>
          <input
            value={ai.baseUrl}
            onChange={(e) => ai.set({ baseUrl: e.target.value.trim() })}
            placeholder={provider.baseUrl || "https://…/v1"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(field, "font-mono text-[13px]")}
          />
          <span className="text-xs text-fg-3">{provider.id === "opencode" ? t.settings.aiGoHint : t.settings.aiBaseUrlHint}</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-fg-2">{t.settings.aiKey}</span>
          <input
            type="password"
            value={ai.apiKey}
            onChange={(e) => ai.set({ apiKey: e.target.value.trim() })}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            className={cn(field, "font-mono text-[13px]")}
          />
          <span className="text-xs text-fg-3">{t.settings.aiKeyHint}</span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-fg-2">{t.settings.aiModel}</span>
          <div className="flex gap-2">
            <input
              value={ai.model}
              onChange={(e) => ai.set({ model: e.target.value.trim() })}
              list="ai-model-options"
              placeholder={t.settings.aiModelPlaceholder}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(field, "min-w-0 flex-1 font-mono text-[13px]")}
            />
            <datalist id="ai-model-options">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              type="button"
              disabled={!canLoad || loading}
              onClick={() => void loadModels()}
              title={t.settings.aiLoadModels}
              aria-label={t.settings.aiLoadModels}
              className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-surface-3 text-fg-2 transition-colors hover:text-fg disabled:opacity-50"
            >
              <ArrowsClockwiseIcon size={18} weight="bold" className={loading ? "animate-spin" : ""} />
            </button>
          </div>
          <span className="text-xs text-fg-3">{t.settings.aiModelHint}</span>
          {loading && <span className="text-xs text-fg-3">{t.settings.aiLoadingModels}</span>}
          {!loading && listError && <span className="text-xs text-danger">{listError}</span>}
          {!loading && !listError && models.length > 0 && (
            <span className="text-xs text-fg-3">{t.settings.aiModelsLoaded(models.length)}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!api.aiTest || !ai.model || test.state === "running"}
            onClick={() => void runTest()}
            className="h-9 rounded-full bg-surface-3 px-4 text-[13px] font-medium text-fg transition-colors hover:bg-surface-4 disabled:opacity-50"
          >
            {test.state === "running" ? t.settings.aiTesting : t.settings.aiTest}
          </button>
          {test.state === "ok" && (
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-accent-text">
              <CheckCircleIcon size={16} weight="fill" /> <span className="truncate">{t.settings.aiTestOk}</span>
            </span>
          )}
          {test.state === "error" && (
            <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-danger">
              <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0" />
              <span className="break-words">{test.message}</span>
            </span>
          )}
        </div>

        <div className="border-t border-line pt-1">
          <SwitchRow
            label={t.settings.aiPersonalize}
            body={t.settings.aiPersonalizeBody}
            checked={ai.personalize}
            onChange={(v) => ai.set({ personalize: v })}
          />
        </div>
      </div>
    </section>
  );
}
