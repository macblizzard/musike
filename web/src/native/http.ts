import { CapacitorHttp } from "@capacitor/core";

/**
 * fetch() for youtubei.js in the Android app. A WebView's own fetch can't talk to YouTube's API: it is cross-origin,
 * and the browser adds an Origin header that YouTube rejects. Requests go through Android's HTTP stack instead
 * (Capacitor's native HTTP), with exactly the headers youtubei.js set.
 */

export interface RawRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (req: RawRequest) => Promise<RawResponse>;

const capacitorTransport: Transport = async (req) => {
  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method,
    headers: req.headers,
    data: req.body,
    responseType: "text",
  });
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return { status: res.status, headers: res.headers ?? {}, body };
};

export function makeFetch(transport: Transport): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // A standalone Headers keeps every header youtubei.js set (a Request would drop some, like User-Agent).
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers ?? undefined).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body ?? undefined;
    const body = raw == null ? undefined : typeof raw === "string" ? raw : await new Response(raw).text();
    const res = await transport({ url, method: init?.method ?? request?.method ?? "GET", headers, body });
    // Statuses without a body (204, 304) can't be given one.
    const bodyless = res.status === 204 || res.status === 304 || (res.status >= 100 && res.status < 200);
    const response = new Response(bodyless ? null : res.body, { status: res.status, headers: res.headers });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

export const nativeFetch = makeFetch(capacitorTransport);
