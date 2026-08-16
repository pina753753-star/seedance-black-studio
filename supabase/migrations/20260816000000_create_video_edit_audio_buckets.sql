-- BGM(動画編集の音声ミックス機能)用のStorageバケットを2つ作成する。
-- reference-image-quarantine(20260802000000)と同じ構成パターンを踏襲する。
--
-- 1. video-edit-audio-quarantine (非公開): 署名付きURL経由でクライアントが
--    直接アップロードした直後の、安全確認前のBGM音声ファイルを一時保存する。
--    サーバー側(api/video-edit-audio-confirm-upload.js、サービスロール)のみが
--    読み書きする。このマイグレーションではstorage.objectsポリシーを作成しない。
-- 2. video-edit-audio (公開): 実体検証(ffprobe)に合格したBGM音声ファイルを
--    複製する先。watermark-server(Railway)が/edit実行時に公開URL経由で
--    直接フェッチしてミックスするため公開バケットとする
--    (api/video-edit.js/watermark-server/server.jsの既存クリップURLと同じ扱い)。
--
-- 再実行しても安全: 既存バケットは要求された設定へ更新される(重複作成しない)。

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'video-edit-audio-quarantine',
  'video-edit-audio-quarantine',
  false,
  15728640, -- 15MB
  array['audio/mpeg']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'video-edit-audio',
  'video-edit-audio',
  true,
  15728640, -- 15MB
  array['audio/mpeg']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
