const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { Pool } = require('pg');

const port = Number(process.env.PORT || 3000);
const root = path.join(__dirname, 'public');
const trendSource = process.env.TREND_SOURCE_URL || 'https://consciousness-digest-production.up.railway.app/trend-data.json';
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;
const MAX_AUDIO = 24 * 1024 * 1024;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function json(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function parseEnvJson(name, fallback) {
  try {
    const raw = process.env[name];
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function slugId(input) {
  const hash = createHash('sha256').update(String(input || '')).digest('hex').slice(0, 12);
  return String(input || 'idea')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) + '-' + hash;
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_notes (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      transcript text NOT NULL,
      language text,
      source text NOT NULL DEFAULT 'web',
      source_trend_title text,
      status text NOT NULL DEFAULT 'processed',
      meta jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS content_packs (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      pack_date date,
      priority text,
      status text NOT NULL DEFAULT 'draft',
      source_trend_title text,
      payload jsonb NOT NULL,
      source_voice_id uuid REFERENCES voice_notes(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS content_items (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      title text NOT NULL,
      status text NOT NULL DEFAULT 'radar',
      winner boolean NOT NULL DEFAULT false,
      notes text NOT NULL DEFAULT '',
      trend jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS performance_events (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      item_id text,
      platform text NOT NULL,
      published_at timestamptz,
      views bigint,
      likes bigint,
      comments bigint,
      shares bigint,
      saves bigint,
      watch_time_seconds numeric,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  const seed = parseEnvJson('CONTENT_PIPELINE_JSON', []);
  for (const pack of Array.isArray(seed) ? seed : []) {
    const id = pack.id || slugId((pack.date || '') + ':' + (pack.sourceTrendTitle || pack.title || 'pack'));
    await pool.query(`
      INSERT INTO content_packs(id, pack_date, priority, status, source_trend_title, payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        updated_at=now(),
        pack_date=EXCLUDED.pack_date,
        priority=EXCLUDED.priority,
        status=EXCLUDED.status,
        source_trend_title=EXCLUDED.source_trend_title,
        payload=EXCLUDED.payload
    `, [id, pack.date || null, pack.priority || null, pack.status || 'draft', pack.sourceTrendTitle || pack.title || null, JSON.stringify({ ...pack, id })]);
  }
}

async function loadTrends() {
  const fallback = parseEnvJson('TREND_FALLBACK_JSON', []);
  try {
    const response = await fetch(trendSource, {
      headers: { 'User-Agent': 'psychology-content-os/2.0' },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw new Error('Trend source returned ' + response.status);
    const data = await response.json();
    return Array.isArray(data) ? data : fallback;
  } catch (error) {
    console.error('Trend source error:', error.message);
    return fallback;
  }
}

function collectBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await collectBody(req, maxBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

async function transcribeAudio(buffer, mimeType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error('OPENAI_API_KEY is not configured'), { statusCode: 503, code: 'transcription_not_configured' });
  const form = new FormData();
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), 'voice.' + ext);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Transcription failed'), { statusCode: 502 });
  return String(data.text || '').trim();
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (typeof c.text === 'string') parts.push(c.text);
      else if (typeof c.output_text === 'string') parts.push(c.output_text);
    }
  }
  return parts.join('\n').trim();
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim().replace(/^\`\`\`json\s*/i, '').replace(/\`\`\`$/,'').trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  throw new Error('Model did not return valid JSON');
}

async function generatePackFromTranscript(transcript, sourceTrendTitle) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const instructions = `You are the editorial engine for Lev's psychology/consciousness media system.
The voice transcript is authoritative. Preserve the speaker's actual argument and unusual language; do not turn it into generic self-help copy.
Never invent personal experiences, patient stories, credentials, research findings, or certainty not present in the transcript.
Keep medical and mental-health claims nuanced.
Return ONLY valid JSON with this exact high-level shape:
{
  "title": string,
  "priority": "A",
  "status": "draft",
  "sourceTrendTitle": string,
  "thesis_ru": string,
  "thesis_en": string,
  "telegram": {"title": string, "body": string},
  "reel_ru": {"hook": string, "script": string, "cta": string},
  "x_en": [string, string, string],
  "youtube": {"title": string, "thesis": string, "outline": [string]},
  "reddit": {"title": string, "body": string},
  "rationale": string
}
Russian: intellectually precise, direct, no influencer clichés.
English: natural for an international research/intellectual audience.
The durable goal is Trend -> Interpretation -> Framework, not trend summary.`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_EDITORIAL_MODEL || 'gpt-5.6-terra',
      input: [
        { role: 'system', content: [{ type: 'input_text', text: instructions }] },
        { role: 'user', content: [{ type: 'input_text', text: `Source trend: ${sourceTrendTitle || 'none'}\n\nVOICE TRANSCRIPT:\n${transcript}` }] }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Editorial generation failed');
  const pack = parseJsonLoose(extractResponseText(data));
  const date = new Date().toISOString().slice(0,10);
  const id = slugId(date + ':' + (sourceTrendTitle || pack.title || transcript.slice(0,80)));
  return { id, date, ...pack, sourceTrendTitle: sourceTrendTitle || pack.sourceTrendTitle || pack.title || null, status: 'draft' };
}

async function saveVoiceAndPack({ transcript, source, language, sourceTrendTitle, mimeType, audioBytes }) {
  const voiceId = randomUUID();
  const meta = { mimeType: mimeType || null, audioBytes: audioBytes || null, audioRetained: false };
  if (pool) {
    await pool.query(`
      INSERT INTO voice_notes(id, transcript, language, source, source_trend_title, meta)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
    `, [voiceId, transcript, language || null, source || 'web', sourceTrendTitle || null, JSON.stringify(meta)]);
  }
  let pack = null;
  try {
    pack = await generatePackFromTranscript(transcript, sourceTrendTitle);
  } catch (error) {
    console.error('Pack generation failed:', error.message);
  }
  if (pack && pool) {
    await pool.query(`
      INSERT INTO content_packs(id, pack_date, priority, status, source_trend_title, payload, source_voice_id)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT (id) DO UPDATE SET updated_at=now(), payload=EXCLUDED.payload, source_voice_id=EXCLUDED.source_voice_id
    `, [pack.id, pack.date || null, pack.priority || 'A', pack.status || 'draft', pack.sourceTrendTitle || null, JSON.stringify(pack), voiceId]);
    const itemId = slugId(pack.sourceTrendTitle || pack.title || pack.id);
    await pool.query(`
      INSERT INTO content_items(id, title, status, notes, trend)
      VALUES($1,$2,'production',$3,$4::jsonb)
      ON CONFLICT (id) DO UPDATE SET updated_at=now(), status='production', notes=EXCLUDED.notes
    `, [itemId, pack.sourceTrendTitle || pack.title || 'Voice idea', 'Created from voice note', JSON.stringify({ sourceVoiceId: voiceId })]);
  }
  return { voiceId, transcript, pack };
}

async function getPacks() {
  if (pool) {
    const { rows } = await pool.query('SELECT payload FROM content_packs ORDER BY created_at DESC LIMIT 100');
    if (rows.length) return rows.map(r => r.payload);
  }
  return parseEnvJson('CONTENT_PIPELINE_JSON', []);
}

async function getItems() {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT id,title,status,winner,notes,trend,created_at,updated_at FROM content_items ORDER BY updated_at DESC');
  return rows;
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/health') return json(res, 200, { ok: true, db: Boolean(pool) });

  if (u.pathname === '/api/config') {
    return json(res, 200, {
      timezone: process.env.CONTENT_TIMEZONE || 'Asia/Makassar',
      database: Boolean(pool),
      transcription: Boolean(process.env.OPENAI_API_KEY),
      transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
      editorialModel: process.env.OPENAI_EDITORIAL_MODEL || 'gpt-5.6-terra'
    });
  }

  if (u.pathname === '/api/trends' && req.method === 'GET') {
    const trends = await loadTrends();
    return json(res, 200, { updatedAt: new Date().toISOString(), trends });
  }

  if (u.pathname === '/api/packs' && req.method === 'GET') {
    return json(res, 200, { updatedAt: new Date().toISOString(), packs: await getPacks() });
  }

  if (u.pathname === '/api/items' && req.method === 'GET') {
    return json(res, 200, { items: await getItems() });
  }

  if (u.pathname === '/api/items' && req.method === 'POST') {
    if (!pool) return json(res, 503, { error: 'Database unavailable' });
    const body = await readJsonBody(req);
    const trend = body.trend || {};
    const title = String(body.title || trend.topic || trend.title || '').trim();
    if (!title) return json(res, 400, { error: 'title required' });
    const id = body.id || slugId(title);
    const status = body.status || 'thesis';
    await pool.query(`
      INSERT INTO content_items(id,title,status,trend)
      VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT (id) DO UPDATE SET updated_at=now(), status=EXCLUDED.status, trend=EXCLUDED.trend
    `, [id, title, status, JSON.stringify(trend)]);
    return json(res, 200, { ok: true, id });
  }

  const itemMatch = u.pathname.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && req.method === 'PATCH') {
    if (!pool) return json(res, 503, { error: 'Database unavailable' });
    const body = await readJsonBody(req);
    const id = decodeURIComponent(itemMatch[1]);
    const { rows } = await pool.query('SELECT * FROM content_items WHERE id=$1', [id]);
    if (!rows.length) return json(res, 404, { error: 'Not found' });
    const current = rows[0];
    await pool.query(`
      UPDATE content_items
      SET status=$2,winner=$3,notes=$4,updated_at=now()
      WHERE id=$1
    `, [id, body.status ?? current.status, body.winner ?? current.winner, body.notes ?? current.notes]);
    return json(res, 200, { ok: true });
  }

  if (u.pathname === '/api/voice' && req.method === 'GET') {
    if (!pool) return json(res, 200, { notes: [] });
    const { rows } = await pool.query('SELECT id,created_at,transcript,language,source,source_trend_title,status,meta FROM voice_notes ORDER BY created_at DESC LIMIT 50');
    return json(res, 200, { notes: rows });
  }

  if (u.pathname === '/api/voice' && req.method === 'POST') {
    const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    if (!mimeType.startsWith('audio/') && !mimeType.includes('webm')) return json(res, 415, { error: 'Audio payload required' });
    const buffer = await collectBody(req, MAX_AUDIO);
    if (!buffer.length) return json(res, 400, { error: 'Empty audio' });
    const transcript = await transcribeAudio(buffer, mimeType);
    if (!transcript) return json(res, 502, { error: 'Empty transcription' });
    const result = await saveVoiceAndPack({
      transcript,
      source: 'voice-recorder',
      language: req.headers['x-language'] || null,
      sourceTrendTitle: req.headers['x-source-trend'] ? decodeURIComponent(String(req.headers['x-source-trend'])) : null,
      mimeType,
      audioBytes: buffer.length
    });
    return json(res, 200, result);
  }

  if (u.pathname === '/api/voice-text' && req.method === 'POST') {
    const body = await readJsonBody(req, 1024 * 1024);
    const transcript = String(body.transcript || '').trim();
    if (!transcript) return json(res, 400, { error: 'transcript required' });
    const result = await saveVoiceAndPack({
      transcript,
      source: body.source || 'text-inbox',
      language: body.language || null,
      sourceTrendTitle: body.sourceTrendTitle || null
    });
    return json(res, 200, result);
  }

  if (u.pathname === '/api/performance' && req.method === 'POST') {
    if (!pool) return json(res, 503, { error: 'Database unavailable' });
    const body = await readJsonBody(req);
    const id = randomUUID();
    await pool.query(`
      INSERT INTO performance_events(id,item_id,platform,published_at,views,likes,comments,shares,saves,watch_time_seconds,raw)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    `, [
      id, body.itemId || null, body.platform || 'unknown', body.publishedAt || null,
      body.views ?? null, body.likes ?? null, body.comments ?? null, body.shares ?? null,
      body.saves ?? null, body.watchTimeSeconds ?? null, JSON.stringify(body)
    ]);
    return json(res, 200, { ok: true, id });
  }

  const safe = u.pathname.replace(/\.\./g, '');
  let filePath = path.join(root, safe === '/' ? 'index.html' : safe);
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (e, data) => {
      if (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    });
  });
}

initDb()
  .then(() => http.createServer((req,res) => route(req,res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message, code: error.code || null });
    else res.end();
  })).listen(port, '0.0.0.0', () => console.log('Psychology Content OS v2 running on ' + port)))
  .catch(error => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
