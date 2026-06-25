-- Confirmed production constraint name: profiles_plan_check
-- Confirmed before migration: ultimate=false, scale=true, team=true
-- Do not run automatically against production without explicit approval

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_plan_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_plan_check
  CHECK (
    plan IN (
      'free',
      'standard',
      'premium',
      'ultimate',
      'scale',
      'team'
    )
  );
