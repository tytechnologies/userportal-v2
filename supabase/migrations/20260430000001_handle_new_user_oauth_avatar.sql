-- Extend public.handle_new_user() to also capture an avatar URL from OAuth
-- providers. Google stamps `picture`; Facebook stamps `picture` (and
-- sometimes `avatar_url`); email/password sign-ups have neither, which is
-- fine — the column stays NULL and the UI falls back to letter-avatars.
--
-- The full_name / name / email local-part fallback chain is unchanged,
-- so the trigger remains backward-compatible with every existing user.
--
-- DEPENDS ON: 20260429000001_create_profiles_table.sql
--
-- ROLLBACK:
--   -- Restore the previous body verbatim (see 20260429000001).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    -- Google → full_name; Facebook → name; email/password → local-part.
    -- Same chain as before, callers do not need to change.
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name',
      split_part(NEW.email, '@', 1)
    ),
    -- Avatar: Google uses `picture`; Facebook uses `picture` too; some
    -- providers stamp `avatar_url`. Take the first present, NULL if none.
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'avatar_url', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'picture', '')
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- One-shot backfill: if an existing profile has no avatar but the auth
-- user does, copy it over. ON CONFLICT-style guarded so re-running is
-- idempotent and we never overwrite an avatar a user has explicitly set.
UPDATE public.profiles p
SET avatar_url = COALESCE(
      NULLIF(u.raw_user_meta_data ->> 'avatar_url', ''),
      NULLIF(u.raw_user_meta_data ->> 'picture', '')
    )
FROM auth.users u
WHERE u.id = p.id
  AND (p.avatar_url IS NULL OR p.avatar_url = '')
  AND COALESCE(
        NULLIF(u.raw_user_meta_data ->> 'avatar_url', ''),
        NULLIF(u.raw_user_meta_data ->> 'picture', '')
      ) IS NOT NULL;
