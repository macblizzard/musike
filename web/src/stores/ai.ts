import { create } from "zustand";
import type { AiProviderConfig } from "../lib/apiTypes";

/**
 * How the AI playlist assistant talks to a model. Kept on this device only (never on the server, which
 * only forwards the request): the key is this phone's or this browser's own.
 */
export interface AiSettings {
  enabled: boolean;
  /** "opencode" or "custom"; the base URL is what actually matters. */
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Send favorites/history to the model so playlists fit what is already being listened to. */
  personalize: boolean;
}

/**
 * Endpoints offered in Settings. OpenCode Go (the subscription plan) is the default; anything
 * OpenAI-compatible — OpenRouter, a local Ollama, a gateway — goes under "custom".
 */
export const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1";

export const AI_PROVIDERS = [
  { id: "opencode", name: "OpenCode Go", baseUrl: OPENCODE_GO_URL, defaultModel: "deepseek-v4.1-flash" },
  { id: "custom", name: "OpenAI-compatible", baseUrl: "", defaultModel: "" },
] as const;

export const DEFAULT_AI: AiSettings = {
  enabled: false,
  provider: "opencode",
  baseUrl: OPENCODE_GO_URL,
  model: "deepseek-v4.1-flash",
  apiKey: "",
  personalize: true,
};

const KEY = "musike:ai";

/** Keeps only known keys with the right types: the value may come from an older version. */
export function cleanAi(input: unknown): AiSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  const str = (k: keyof AiSettings) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const out: AiSettings = { ...DEFAULT_AI };
  if (typeof v.enabled === "boolean") out.enabled = v.enabled;
  if (typeof v.personalize === "boolean") out.personalize = v.personalize;
  out.provider = str("provider") || DEFAULT_AI.provider;
  out.baseUrl = (str("baseUrl") || DEFAULT_AI.baseUrl).trim().replace(/\/+$/, "");
  // An earlier build pointed the OpenCode preset at the pay-as-you-go relay, not the Go plan.
  if (out.provider === "opencode" && out.baseUrl.endsWith("/zen/v1")) out.baseUrl = OPENCODE_GO_URL;
  // A settings object saved before a model was chosen must not erase the default.
  out.model = str("model").trim() || DEFAULT_AI.model;
  out.apiKey = str("apiKey");
  return out;
}

function read(): AiSettings {
  try {
    return cleanAi(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_AI };
  }
}

interface AiState extends AiSettings {
  set: (patch: Partial<AiSettings>) => void;
  /** What the server needs for one request. */
  config: () => AiProviderConfig;
  /** On, with a URL and a model: enough to offer the assistant in the UI. */
  ready: () => boolean;
}

export const useAi = create<AiState>((set, get) => ({
  ...read(),

  set: (patch) => {
    set(patch);
    const { enabled, provider, baseUrl, model, apiKey, personalize } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled, provider, baseUrl, model, apiKey, personalize }));
    } catch {
      /* private mode */
    }
  },

  config: () => {
    const { provider, baseUrl, model, apiKey } = get();
    return { provider, baseUrl, model, apiKey: apiKey.trim() };
  },

  ready: () => {
    const { enabled, baseUrl, model } = get();
    return !!enabled && /^https?:\/\/.+/.test(baseUrl) && !!model.trim();
  },
}));

/** For code outside React (the assistant dialog's polling, the track menu). */
export const aiReady = () => useAi.getState().ready();
