-- =============================================================
-- PROVIDER ROUTING TABLE
-- Stores which VTU provider (bigisub | alrahuz) handles each
-- service. A single row per service with a global fallback.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.provider_routing (
    service     VARCHAR(20) PRIMARY KEY,  -- airtime, data, cable, electricity, epin
    provider    VARCHAR(20) NOT NULL DEFAULT 'bigisub',  -- bigisub | alrahuz
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed defaults: everything on bigisub unless the admin switches
INSERT INTO public.provider_routing (service, provider) VALUES
    ('airtime',     'bigisub'),
    ('data',        'bigisub'),
    ('cable',       'bigisub'),
    ('electricity', 'bigisub'),
    ('epin',        'bigisub')
ON CONFLICT (service) DO NOTHING;

-- RLS: admin-only access (service role bypasses RLS anyway)
ALTER TABLE public.provider_routing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON public.provider_routing
    FOR ALL USING (true) WITH CHECK (true);
