-- =============================================================
-- WALLET + VIRTUAL ACCOUNT + TRANSACTION LOG (idempotent)
-- Reconciles the schema used by the fund-wallet / purchase flow:
--   - wallets: user_id + balance
--   - users: virtual account columns persisted by Squad provisioning
--   - transactions: permanent log (title, service_type, amount, recipient, status, reference)
-- =============================================================

-- 1. WALLETS
CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. USERS (holds Squad dedicated virtual account details + KYC fields)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY,
    name TEXT,
    email TEXT,
    phone TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    squad_customer_id TEXT,
    virtual_account_number TEXT,
    virtual_bank_name TEXT,
    virtual_account_name TEXT,
    bvn TEXT,
    dob TEXT,
    gender TEXT,
    address TEXT
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS bvn TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dob TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS address TEXT;

-- 3. TRANSACTIONS LOG
-- The earlier migration created a data-plan-centric shape; ensure the
-- permanent log columns used by the purchase/funding flow exist as well.
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    title TEXT,
    service_type VARCHAR(30),
    amount NUMERIC(12, 2),
    recipient VARCHAR(100),
    status VARCHAR(20) DEFAULT 'successful',
    reference VARCHAR(100) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS service_type VARCHAR(30);
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2);
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS recipient VARCHAR(100);
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'successful';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

-- The earlier migration declared phone_number/amount_charged/corporate_cost/profit
-- as NOT NULL, but the wallet purchase/funding flow only writes the log columns
-- above. Relax those legacy constraints so inserts succeed on DBs that already
-- ran the 20260812 migration.
ALTER TABLE public.transactions ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE public.transactions ALTER COLUMN amount_charged DROP NOT NULL;
ALTER TABLE public.transactions ALTER COLUMN corporate_cost DROP NOT NULL;
ALTER TABLE public.transactions ALTER COLUMN profit DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON public.transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- 4. ROW LEVEL SECURITY
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Users can read their own wallet / transactions / profile row
DROP POLICY IF EXISTS "Users select own wallet" ON public.wallets;
CREATE POLICY "Users select own wallet" ON public.wallets
    FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users select own transactions" ON public.transactions;
CREATE POLICY "Users select own transactions" ON public.transactions
    FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users select own users row" ON public.users;
CREATE POLICY "Users select own users row" ON public.users
    FOR SELECT USING (auth.uid() = id);

-- Service role full control (backend uses service role key)
DROP POLICY IF EXISTS "Service role full access to wallets" ON public.wallets;
CREATE POLICY "Service role full access to wallets" ON public.wallets
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "Service role full access to transactions" ON public.transactions;
CREATE POLICY "Service role full access to transactions" ON public.transactions
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "Service role full access to users" ON public.users;
CREATE POLICY "Service role full access to users" ON public.users
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
