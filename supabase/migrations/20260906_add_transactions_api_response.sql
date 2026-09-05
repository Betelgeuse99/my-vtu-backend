-- Persist the full provider response on successful purchases so the app/web can
-- re-render detailed receipts (electricity token, cable plan, exam PINs, raw
-- provider message, etc.) straight from transaction history.
--
-- The edge-function logTx no longer depends on this column (it attaches it via
-- a best-effort update), so transactions are recorded even before this runs —
-- but without it, no api_response / receipt data is stored.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS api_response JSONB;
