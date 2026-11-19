-- Security hardening
-- 1) Credit functions are server-only (edge functions use the service role).
--    Postgres grants EXECUTE to PUBLIC by default, so any signed-in user could
--    call add_credits(<self>, 999999) through the REST API.
REVOKE EXECUTE ON FUNCTION public.add_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.add_credits_by_email(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.deduct_credit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_credit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_credits_by_email(text, integer) TO service_role;

-- 2) Users must not be able to edit their own credits / plan from the browser.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles; -- rows are created by the signup trigger
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon, authenticated;

-- 3) Atomic spend: deducts only if the balance covers it. Returns new balance, or -1.
CREATE OR REPLACE FUNCTION public.spend_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;
  UPDATE profiles
     SET credits = credits - p_amount
   WHERE id = p_user_id AND credits >= p_amount
  RETURNING credits INTO remaining;
  RETURN COALESCE(remaining, -1);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_credits(uuid, integer) TO service_role;

-- 4) On-chain agent payments: one row per tx hash → a payment can't be replayed.
CREATE TABLE IF NOT EXISTS public.agent_payments (
  tx_hash      text PRIMARY KEY,
  payer        text NOT NULL,
  amount_units numeric NOT NULL,
  target_url   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at  timestamptz
);
ALTER TABLE public.agent_payments ENABLE ROW LEVEL SECURITY; -- no policies: service role only

-- 5) New accounts get enough credits for a real first try
--    (one generation costs ~55-115 credits and the minimum balance is 100).
CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, credits, plan_name)
  VALUES (NEW.id, NEW.email, 300, 'Free');
  RETURN NEW;
END;
$function$;
