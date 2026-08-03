begin;

create table public.service_controls (
  control_key text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  constraint service_controls_known_key_check
    check (control_key in ('video_generation'))
);

alter table public.service_controls enable row level security;

revoke all on table public.service_controls from public, anon, authenticated, service_role;
grant select on table public.service_controls to service_role;

insert into public.service_controls (control_key, enabled)
values ('video_generation', true);

commit;
