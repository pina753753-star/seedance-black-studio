const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WATERMARK_SECRET = process.env.WATERMARK_SECRET || '';
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'FlowVid Watermark Server', version: '1.0.0' });
});

app.post('/watermark', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (WATERMARK_SECRET && auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ ok: false, error: 'videoUrl is required' });

  const uid = uuidv4();
  const inputFile = path.join('/tmp', `in_${uid}.mp4`);
  const outputFile = path.join('/tmp', `out_${uid}.mp4`);

  try {
    const response = await fetch(videoUrl, { timeout: 120000 });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(inputFile, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .outputOptions([
          '-vf', "drawtext=text=FlowVid:fontsize=28:fontcolor=white@0.85:x=w-tw-20:y=h-th-20:shadowcolor=black@0.8:shadowx=2:shadowy=2",
          '-c:a', 'copy',
          '-movflags', '+faststart'
        ])
        .output(outputFile)
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`ffmpeg: ${err.message}`)))
        .run();
    });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const fileBuffer = fs.readFileSync(outputFile);
    const storagePath = `watermarked/${uid}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('reference-images')
      .upload(storagePath, fileBuffer, { contentType: 'video/mp4', upsert: false });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage
      .from('reference-images')
      .getPublicUrl(storagePath);

    return res.json({ ok: true, watermarkedUrl: urlData.publicUrl });
  } catch (err) {
    console.error('[watermark] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (_) {}
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (_) {}
  }
});

app.listen(PORT, () => {
  console.log(`FlowVid Watermark Server listening on port ${PORT}`);
});
