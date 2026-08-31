import { requestJson } from "../net.ts";

const BIGISUB_BASE_URL = "https://api.bigisub.ng";
const BIGISUB_TOKEN = Deno.env.get("BIGISUB_TOKEN") || Deno.env.get("BIGISUB_API_KEY") || "";
export const DEFAULT_PIN = Deno.env.get("BIGISUB_PIN") || "1234";

function headers() {
  return { Authorization: "Token " + BIGISUB_TOKEN, "Content-Type": "application/json" };
}

/**
 * axios-shaped client: methods return Promise<{ status, data, headers }> and
 * throw HttpError (which carries `.response.status` / `.response.data`) on
 * 4xx/5xx — identical to the Node axios client the server used.
 */
export const bigiClient = {
  get: (path: string, opts: { timeoutMs?: number } = {}) =>
    requestJson(BIGISUB_BASE_URL + path, { headers: headers(), timeoutMs: opts.timeoutMs ?? 25000 }),
  post: (path: string, body: unknown) =>
    requestJson(BIGISUB_BASE_URL + path, { method: "POST", headers: headers(), body }),
};
