-- =============================================================
-- ALRAHUZDATA SUPPORT ON THE UNIFIED data_plans CATALOG
-- Each plan row can be fulfilled by EITHER provider:
--   bigi_plan_id / buy_price          -> Bigisub routing
--   alrahuz_plan_id / alrahuz_buy_price -> Alrahuzdata routing
-- alrahuz_retail_price is an OPTIONAL per-provider selling price;
-- when NULL the shared retail_price is charged regardless of route.
-- =============================================================

ALTER TABLE public.data_plans
    ADD COLUMN IF NOT EXISTS alrahuz_plan_id VARCHAR(50);

ALTER TABLE public.data_plans
    ADD COLUMN IF NOT EXISTS alrahuz_buy_price NUMERIC(10, 2);

ALTER TABLE public.data_plans
    ADD COLUMN IF NOT EXISTS alrahuz_retail_price NUMERIC(10, 2);

-- Uniqueness for upserts (partial: multiple NULLs are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_data_plans_alrahuz_plan_id
    ON public.data_plans (alrahuz_plan_id)
    WHERE alrahuz_plan_id IS NOT NULL;

-- Provider column on transactions already exists; index it for the admin ledger filter
CREATE INDEX IF NOT EXISTS idx_transactions_provider
    ON public.transactions (provider);
