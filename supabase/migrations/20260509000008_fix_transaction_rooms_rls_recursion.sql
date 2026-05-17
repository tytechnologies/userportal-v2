-- Hotfix: infinite RLS recursion between transaction_rooms and
-- transaction_room_participants.
--
-- Cause: phase-1 migration 20260509000004 set up two policies that
-- cross-reference each other:
--
--   transaction_rooms_read    -- USING EXISTS (SELECT FROM trp ...)
--   trp_read                  -- USING EXISTS (SELECT FROM transaction_rooms r ...)
--
-- When the planner expands the inner SELECTs, each subquery's RLS
-- fires the *other* policy, which fires the original policy again,
-- and Postgres aborts with:
--
--     "infinite recursion detected in policy for relation
--      transaction_rooms"
--
-- Fix: use a SECURITY DEFINER helper to check participant membership
-- without firing trp's RLS. The helper is owned by postgres and
-- bypasses row-level security on its inner SELECT, so the rooms_read
-- policy can call it without triggering trp_read.
--
-- We also tighten trp_read so it doesn't depend on transaction_rooms
-- visibility — a participant either appears in a room they're in
-- (user_id = auth.uid()), or they own the room outright. Those are
-- direct-attribute checks; no policy crosses to a peer table.

-- 1. Helper: is the caller a participant in the given room?
CREATE OR REPLACE FUNCTION public.is_transaction_room_participant(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.transaction_room_participants p
     WHERE p.room_id = p_room_id
       AND p.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_transaction_room_participant(uuid) TO authenticated;

-- 2. Helper: is the caller the owner of the given room?
--    Same SECURITY DEFINER pattern; lets trp_read check ownership
--    without triggering transaction_rooms_read.
CREATE OR REPLACE FUNCTION public.is_transaction_room_owner(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.transaction_rooms r
     WHERE r.id = p_room_id
       AND r.owner_user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_transaction_room_owner(uuid) TO authenticated;

-- 3. Rebuild transaction_rooms_read using the helper.
DROP POLICY IF EXISTS transaction_rooms_read ON public.transaction_rooms;
CREATE POLICY transaction_rooms_read ON public.transaction_rooms
  FOR SELECT TO authenticated
  USING (
       owner_user_id = auth.uid()
    OR public.has_permission('transactions.read.all')
    OR public.is_transaction_room_participant(transaction_rooms.id)
  );

-- 4. Rebuild trp_read so it stops cross-referencing transaction_rooms
--    via RLS-firing EXISTS. A participant row is visible if:
--      a) the caller IS that participant (user_id = auth.uid()), OR
--      b) the caller is the room owner (checked via SECURITY DEFINER
--         helper, no RLS trigger), OR
--      c) the caller has the platform-wide read permission.
DROP POLICY IF EXISTS trp_read ON public.transaction_room_participants;
CREATE POLICY trp_read ON public.transaction_room_participants
  FOR SELECT TO authenticated
  USING (
       user_id = auth.uid()
    OR public.has_permission('transactions.read.all')
    OR public.is_transaction_room_owner(transaction_room_participants.room_id)
  );

-- 5. trp_write / trp_delete also cross-reference transaction_rooms
--    via EXISTS — same recursion risk, even though writes don't show
--    in the original log. Switch them to the helper too while we're
--    here. Same authorization shape as before: room owner OR
--    transactions.write permission.
DROP POLICY IF EXISTS trp_write  ON public.transaction_room_participants;
CREATE POLICY trp_write ON public.transaction_room_participants
  FOR INSERT TO authenticated
  WITH CHECK (
       public.is_transaction_room_owner(room_id)
    OR public.has_permission('transactions.write')
  );

DROP POLICY IF EXISTS trp_delete ON public.transaction_room_participants;
CREATE POLICY trp_delete ON public.transaction_room_participants
  FOR DELETE TO authenticated
  USING (
       public.is_transaction_room_owner(room_id)
    OR public.has_permission('transactions.write')
  );
