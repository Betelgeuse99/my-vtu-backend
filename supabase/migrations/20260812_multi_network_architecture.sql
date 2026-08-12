-- =============================================================
-- 1. NETWORKS MASTER TABLE (ORDER: MTN, GLO, AIRTEL, 9MOBILE)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.networks (
    id INT PRIMARY KEY,
    name VARCHAR(20) NOT NULL UNIQUE,       -- MTN, GLO, AIRTEL, 9MOBILE
    bigi_network_id VARCHAR(10) NOT NULL,   -- BigiSub Network ID (1, 2, 3, 4)
    is_active BOOLEAN DEFAULT TRUE
);

-- Insert/Update mapped strictly to sequence: 1=MTN, 2=GLO, 3=AIRTEL, 4=9MOBILE
INSERT INTO public.networks (id, name, bigi_network_id) VALUES
    (1, 'MTN', '1'),
    (2, 'GLO', '2'),
    (3, 'AIRTEL', '3'),
    (4, '9MOBILE', '4')
ON CONFLICT (id) DO UPDATE SET 
    name = EXCLUDED.name,
    bigi_network_id = EXCLUDED.bigi_network_id,
    is_active = EXCLUDED.is_active;

-- =============================================================
-- 2. ENHANCED DATA PLANS TABLE (FOREIGN KEYS & DYNAMIC MARGINS)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.data_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network_id INT NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
    bigi_plan_id VARCHAR(50) NOT NULL UNIQUE, -- ID required in BigiSub API payload
    plan_type VARCHAR(30) NOT NULL,            -- SME, SME2, GIFTING, CGIFTING, DIRECT
    volume VARCHAR(20) NOT NULL,               -- e.g. '1GB', '500MB'
    validity VARCHAR(50) NOT NULL,             -- e.g. '30 Days', '1 day'
    
    -- Pricing Columns
    buy_price NUMERIC(10, 2) NOT NULL,         -- BigiSub Corporate Cost Price
    retail_price NUMERIC(10, 2) NOT NULL,      -- Selling Price to Customer
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Automatic Profit Calculation Columns (Postgres Generated)
    profit_amount NUMERIC(10, 2) GENERATED ALWAYS AS (retail_price - buy_price) STORED,
    profit_margin_pct NUMERIC(5, 2) GENERATED ALWAYS AS (
        CASE 
            WHEN retail_price > 0 THEN ROUND(((retail_price - buy_price) / retail_price) * 100, 2)
            ELSE 0.00
        END
    ) STORED,
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_plans_net_active ON public.data_plans(network_id, is_active);

-- =============================================================
-- 3. TRANSACTIONS LOG TABLE (IDEMPOTENCY & AUDITING)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference VARCHAR(100) UNIQUE NOT NULL,     -- Internal transaction ref
    user_id UUID NOT NULL,                      -- Auth customer ID
    plan_id UUID REFERENCES public.data_plans(id) ON DELETE SET NULL,
    phone_number VARCHAR(15) NOT NULL,
    amount_charged NUMERIC(10, 2) NOT NULL,
    corporate_cost NUMERIC(10, 2) NOT NULL,
    profit NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',       -- PENDING, SUCCESS, FAILED
    api_response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_status ON public.transactions(user_id, status);

-- =============================================================
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================
ALTER TABLE public.networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Allow public read access to active networks & data plans
CREATE POLICY "Allow public read access to networks" ON public.networks FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Allow public read access to data_plans" ON public.data_plans FOR SELECT USING (is_active = TRUE);

-- Service Role full control
CREATE POLICY "Service role full access to transactions" ON public.transactions FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
