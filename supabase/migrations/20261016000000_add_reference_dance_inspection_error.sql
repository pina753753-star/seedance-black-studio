alter table public.seedance_reference_video_uploads
  add column if not exists inspection_error text;

comment on column public.seedance_reference_video_uploads.inspection_error is
  'Safe allow-listed code from the most recent retryable inspection failure; never stores secrets or raw upstream bodies.';
