'use strict';

// 動画編集BGM機能用の音声ファイル実体検証。ffprobeで実際にデコードし、
// 「音声ストリームを含む、実在する音声ファイルか」をMIME判定より一段深く確認する。
//
// Vercelサーバーレス関数の実行環境にはシステムのffmpeg/ffprobeが存在しないため
// (watermark-server/server.jsとは異なりDockerfileを持たない標準Node実行環境)、
// ffprobe-staticパッケージが同梱する静的バイナリをchild_processから直接呼び出す。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffprobePath = require('ffprobe-static').path;

const PROBE_TIMEOUT_MS = 10000;
const PROBE_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // ffprobeのJSON出力自体の上限。音声ファイル本体のサイズ上限とは別。

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

// buffer: アップロードされたファイルの生バイト列。
// maxDurationSeconds: 指定時、これを超える長さのファイルはinvalidとして扱う。
//
// 戻り値:
//   { ok: true, duration }
//   { ok: false, reason: 'unreadable' | 'no_audio_stream' | 'invalid_duration' | 'duration_too_long', detail?, duration? }
async function probeAudioBuffer(buffer, { maxDurationSeconds } = {}) {
  const tmpPath = path.join(
    os.tmpdir(),
    `audio-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  try {
    fs.writeFileSync(tmpPath, buffer);

    let data;
    try {
      data = await runFfprobe(tmpPath);
    } catch (err) {
      // ffprobeが失敗する(=デコードできない)場合、壊れたファイル・音声以外の
      // ファイルにMIMEタイプだけ偽装されている等が考えられる。詳細はサーバー
      // ログにのみ残し、クライアントへは返さない(他の検証と同じ方針)。
      return { ok: false, reason: 'unreadable', detail: err && err.message };
    }

    const streams = Array.isArray(data.streams) ? data.streams : [];
    const hasAudioStream = streams.some((s) => s && s.codec_type === 'audio');
    if (!hasAudioStream) {
      return { ok: false, reason: 'no_audio_stream' };
    }

    const duration = Number(data.format && data.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, reason: 'invalid_duration' };
    }

    if (Number.isFinite(maxDurationSeconds) && duration > maxDurationSeconds) {
      return { ok: false, reason: 'duration_too_long', duration };
    }

    return { ok: true, duration };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      // 一時ファイル削除の失敗は無視する(Vercel関数の/tmpは実行終了後に破棄される)。
    }
  }
}

module.exports = { probeAudioBuffer };
