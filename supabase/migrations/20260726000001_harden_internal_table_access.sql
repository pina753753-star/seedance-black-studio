begin;
alter table public.generated_videos enable row level security;
drop policy if exists
  "Allow service role full access to generated videos"
on public.generated_videos;
revoke all on table public.generated_videos
from public, anon, authenticated;
grant select, insert, update, delete
on table public.generated_videos
to service_role;

alter table public.user_subscriptions enable row level security;
alter table public.video_edit_tasks enable row level security;
alter table public.annual_credit_grant_log enable row level security;
alter table public.flowvid_video_history enable row level security;
revoke all on table
  public.user_subscriptions,
  public.video_edit_tasks,
  public.annual_credit_grant_log,
  public.flowvid_video_history
from public, anon, authenticated;
grant select, insert, update, delete
on table
  public.user_subscriptions,
  public.video_edit_tasks,
  public.annual_credit_grant_log,
  public.flowvid_video_history
to service_role;

revoke all on schema private
from public, anon, authenticated;
grant usage on schema private
to service_role;
alter table private.signup_credit_campaigns enable row level security;
alter table private.signup_credit_grants enable row level security;
alter table private.user_age_verifications enable row level security;
revoke all on table
  private.signup_credit_campaigns,
  private.signup_credit_grants,
  private.user_age_verifications
from public, anon, authenticated;
grant select, insert, update, delete
on table
  private.signup_credit_campaigns,
  private.signup_credit_grants,
  private.user_age_verifications
to service_role;

revoke execute on function public.handle_new_user()
from public, anon, authenticated;
revoke execute on function public.set_generation_task_finished_at()
from public, anon, authenticated;
revoke execute on function public.is_admin()
from public, anon;
grant execute on function public.is_admin()
to authenticated, service_role;
commit;
