// Minimal axios-compatible HTTP layer for Deno Edge Functions.
//
// The Express server used axios, whose errors carry `.response.status` /
// `.response.data` and whose timeouts carry `code = "ECONNABORTED"`. The whole
// purchase flow branches on those shapes (4xx => refund, 5xx/timeout => keep
// charge + mark pending), so this layer reproduces them exactly.

export class HttpError extends Error {
  status: number;
  data: unknown;
  response: { status: number; data: unknown };
  constructor(status: number, data: unknown) {
    const obj = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const msg =
      (obj?.message as string) ||
      (obj?.detail as string) ||
      (obj?.api_response as string) ||
      (typeof data === "string" ? data : "") ||
      "HTTP " + status;
    super(String(msg));
    this.status = status;
    this.data = data;
    this.response = { status, data };
  }
}

export interface JsonResponse {
  status: number;
  data: unknown;
  headers: Headers;
}

export interface RequestJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  followRedirect?: boolean;
  okStatus?: (status: number) => boolean;
}

export async function requestJson(
  url: string,
  opts: RequestJsonOptions = {},
): Promise<JsonResponse> {
  const u = new URL(url);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
  try {
    const res = await fetch(u.toString(), {
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body === undefined
        ? undefined
        : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body),
      redirect: opts.followRedirect === undefined ? "follow" : opts.followRedirect ? "follow" : "manual",
      signal: controller.signal,
    });

    const text = await res.text();
    let data: unknown = text;
    if ((res.headers.get("content-type") || "").includes("json") && text) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep raw text
      }
    }

    const ok = opts.okStatus ? opts.okStatus(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) throw new HttpError(res.status, data);
    return { status: res.status, data, headers: res.headers };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const e = new Error(err instanceof Error ? err.message : String(err));
    (e as { code?: string }).code = (err as { name?: string })?.name === "AbortError"
      ? "ECONNABORTED"
      : "ERR_NETWORK";
    (e as { response?: undefined }).response = undefined;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads Set-Cookie headers across Deno runtimes (getSetCookie or fallback). */
export function getSetCookie(headers: Headers): string[] {
  const h = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  return [];
}
