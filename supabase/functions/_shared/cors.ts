export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-reconcile-key, x-squad-signature, x-squad-encrypted-body",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Returns an OPTIONS short-circuit response, or null when the request is real. */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}

/**
 * The path segment AFTER the function name, so a function named `vtu` maps
 * `.../functions/v1/vtu/data/plans` to `/data/plans`. This is what lets one
 * edge function behave like a mini-Express router.
 *
 * Verified live on Supabase: a call to /functions/v1/vtu/data/plans arrives
 * with req.url pathname `/vtu/data/plans` (the platform strips `/functions/v1`
 * but keeps the function name as the first segment). Handle that shape, plus
 * the full `/functions/v1/<name>/...` shape defensively (local `serve`).
 */
export function routePath(req: Request): string {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const seg = pathname.split("/").filter((s) => s.length > 0);
  if (seg[0] === "functions" && seg[1] === "v1") {
    return "/" + seg.slice(3).join("/");
  }
  return "/" + seg.slice(1).join("/");
}

export function queryParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
