-- Persist provider details on purchases so the app/web/admin can re-render
-- detailed receipts straight from transaction history:
--   * api_response - full provider response (electricity token, cable plan,
--     exam PINs, raw message, etc.)
--   * plan_id      - the data plan identifier (data_plans row id / plan ref)
--
-- The edge-function logTx attaches these via best-effort updates, so
-- transactions are recorded even before this migration runs — but without it,
-- no receipt/plan data is stored.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS api_response JSONB,
  ADD COLUMN IF NOT EXISTS plan_id TEXT;
