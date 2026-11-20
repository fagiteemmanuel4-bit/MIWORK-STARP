-- Strap / Neon PostgreSQL schema
-- Run this file once in Neon SQL Editor. Safe to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  name text NOT NULL,
  photo_url text,
  neon_auth_user_id text UNIQUE,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
UPDATE users SET name = COALESCE(NULLIF(BTRIM(name), ''), full_name);
ALTER TABLE users ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  currency varchar(8) NOT NULL DEFAULT 'NGN',
  country text,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
  is_default boolean NOT NULL DEFAULT false,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS businesses_one_default_per_owner
  ON businesses(owner_id) WHERE is_default = true;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signup','verify','reset')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verifications_lookup_idx
  ON email_verifications(email,purpose,created_at DESC);

-- App modules persist their account-scoped JSON documents here.
-- This is server-side Neon storage, not browser localStorage/sessionStorage.
CREATE TABLE IF NOT EXISTS account_data (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_ref text NOT NULL UNIQUE,
  provider_transaction_id text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed')),
  purpose text NOT NULL DEFAULT 'subscription',
  provider_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id,created_at DESC);

CREATE OR REPLACE FUNCTION strap_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION strap_set_updated_at();
DROP TRIGGER IF EXISTS businesses_updated_at ON businesses;
CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses
FOR EACH ROW EXECUTE FUNCTION strap_set_updated_at();
