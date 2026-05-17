-- public.profiles: app-level user data (display name, avatar, contact info).
-- 1:1 with auth.users; the row is auto-created via a trigger so every
-- authenticated user has a profile immediately on signup.
--
-- Replaces the failing client-side `from('users')` query and gives the app
-- a stable place for user-facing fields without leaking the auth schema.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--   DROP FUNCTION IF EXISTS public.handle_new_user();
--   DROP TABLE IF EXISTS public.profiles;

CREATE TABLE IF NOT EXISTS public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     text,
  email         text,
  avatar_url    text,
  designation   text,
  mobile_phone  text,
  home_phone    text,
  fb_link       text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_email     ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_full_name ON public.profiles(full_name);

COMMENT ON TABLE  public.profiles IS 'Per-user app data; FK + trigger keep it 1:1 with auth.users.';
COMMENT ON COLUMN public.profiles.id IS 'Same as auth.users.id; cascades on auth user deletion.';
COMMENT ON COLUMN public.profiles.avatar_url IS 'Signed S3 URL or path; rendered in nav + lists.';

-- Auto-update updated_at on every change (idempotent helper).
CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- Auto-create a profile row whenever a new auth user is created.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    -- If the user provided their name in signup metadata, use it; otherwise
    -- fall back to the email's local-part. Either way the profile is never null.
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill: every existing auth user gets a profile row.
-- Uses ON CONFLICT so re-running the migration is safe.
INSERT INTO public.profiles (id, email, full_name)
SELECT
  u.id,
  u.email,
  COALESCE(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    split_part(u.email, '@', 1)
  )
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- Best-effort enrichment from any contact row that matches the user by email.
-- Skips rows where the contact's full_name is null / empty.
UPDATE public.profiles p
SET
  full_name    = COALESCE(NULLIF(p.full_name, ''), c.full_name),
  designation  = COALESCE(p.designation, c.designation),
  mobile_phone = COALESCE(p.mobile_phone, c.mobile_phone),
  home_phone   = COALESCE(p.home_phone,   c.home_phone),
  fb_link      = COALESCE(p.fb_link,      c.link),
  notes        = COALESCE(p.notes,        c.notes)
FROM public.contacts c
WHERE c.owner_user_id = p.id
  AND c.email = p.email
  AND c.full_name IS NOT NULL
  AND c.full_name <> '';

-- RLS: anyone authenticated can read profiles (needed for "uploaded by"
-- display in lists), only the user themselves can update their own profile.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_authenticated ON public.profiles;
CREATE POLICY profiles_select_authenticated
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- INSERT is gated to the user themselves (the trigger uses SECURITY DEFINER
-- so it bypasses RLS, but a manual INSERT still needs a policy).
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

-- DELETE is intentionally not allowed via the API; the auth.users CASCADE
-- handles cleanup when an account is removed.
