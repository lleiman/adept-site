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
    CREATE TABLE IF NOT EXISTS published_assets (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      item_id text REFERENCES content_items(id) ON DELETE SET NULL,
      platform text NOT NULL,
      external_id text NOT NULL,
      url text,
      title text,
      published_at timestamptz,
      last_synced_at timestamptz,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX IF NOT EXISTS published_assets_platform_external_idx
      ON published_assets(platform, external_id);
    CREATE TABLE IF NOT EXISTS performance_events (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      asset_id uuid REFERENCES published_assets(id) ON DELETE CASCADE,
      item_id text,
      platform text NOT NULL,
      published_at timestamptz,
      views bigint,
      reach bigint,
      impressions bigint,
      likes bigint,
      comments bigint,
      shares bigint,
      saves bigint,
      bookmarks bigint,
      profile_clicks bigint,
      subscribers_gained bigint,
      watch_time_seconds numeric,
      average_view_duration numeric,
      completion_rate numeric,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES published_assets(id) ON DELETE CASCADE;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS reach bigint;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS impressions bigint;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS bookmarks bigint;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS profile_clicks bigint;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS subscribers_gained bigint;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS average_view_duration numeric;
    ALTER TABLE performance_events ADD COLUMN IF NOT EXISTS completion_rate numeric;
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
  "visual_strategy": {"primary_format": "carousel" | "gif" | "reel", "reason": string},
  "carousel_ru": {
    "format": "1080x1350",
    "cover": string,
    "slides": [{"n": number, "headline": string, "body": string, "visual": string}],
    "caption": string,
    "visual_direction": string
  },
  "gif": {
    "language": "none" | "ru" | "en",
    "aspect_ratio": "4:5" | "1:1",
    "duration_seconds": number,
    "loop": boolean,
    "purpose": string,
    "frames": [{"frame": number, "text": string, "visual": string, "motion": string}],
    "prompt": string,
    "visual_direction": string
  },
  "rationale": string
}
Russian: intellectually precise, direct, no influencer clichés.
English: natural for an international research/intellectual audience.
Carousel rules: 6-9 slides, one idea per slide, the cover must create cognitive tension without clickbait, body copy must be short enough to read on mobile, and the final slide should crystallize a reusable concept rather than use a generic CTA.
GIF rules: 4-8 frames, simple readable motion, visually intelligible without sound, seamless loop when conceptually appropriate, minimal text, and a clear psychological/conceptual metaphor rather than decorative motion.
Visual style profile:
${JSON.stringify(parseEnvJson('VISUAL_STYLE_JSON', {
  name: 'Leo Psychology Editorial',
  principles: ['dark editorial', 'conceptual not therapeutic', 'high contrast', 'large typography', 'negative space', 'cinematic restraint', 'one acid accent'],
  palette: ['#090A0C','#F4F5F7','#D9FF69'],
  avoid: ['pastel wellness aesthetics','stock therapy imagery','generic gradients','emoji-led self-help','busy infographics']
}))}
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

function analyticsSourceState() {
  return [
    {
      id: 'instagram',
      name: 'Instagram',
      configured: Boolean(process.env.INSTAGRAM_USER_ID && process.env.INSTAGRAM_ACCESS_TOKEN),
      mode: 'Instagram Professional Insights',
      needs: ['INSTAGRAM_USER_ID','INSTAGRAM_ACCESS_TOKEN']
    },
    {
      id: 'youtube',
      name: 'YouTube',
      configured: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN),
      mode: 'YouTube Analytics API',
      needs: ['YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN']
    },
    {
      id: 'x',
      name: 'X',
      configured: Boolean(process.env.X_USER_ID && process.env.X_BEARER_TOKEN),
      mode: 'X API v2 public metrics',
      needs: ['X_USER_ID','X_BEARER_TOKEN']
    },
    {
      id: 'telegram',
      name: 'Telegram',
      configured: false,
      mode: 'MTProto channel statistics',
      needs: ['admin MTProto authorization']
    },
    {
      id: 'reddit',
      name: 'Reddit',
      configured: Boolean(process.env.REDDIT_USERNAME),
      mode: 'Public post metrics',
      needs: ['REDDIT_USERNAME']
    }
  ];
}

function numeric(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function externalIdFromUrl(platform, url) {
  const value = String(url || '').trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if (platform === 'youtube') {
      if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || null;
      return u.searchParams.get('v') || (u.pathname.match(/\/shorts\/([^/?]+)/)?.[1]) || null;
    }
    if (platform === 'instagram') return u.pathname.split('/').filter(Boolean)[1] || u.pathname.split('/').filter(Boolean)[0] || null;
    if (platform === 'x') return u.pathname.match(/\/status\/(\d+)/)?.[1] || null;
    if (platform === 'reddit') return u.pathname.match(/\/comments\/([^/]+)/)?.[1] || null;
    if (platform === 'telegram') return u.pathname.split('/').filter(Boolean).slice(-1)[0] || null;
  } catch {}
  return null;
}

async function upsertAsset({ platform, externalId, url, title, publishedAt, raw, itemId = null }) {
  if (!pool || !externalId) return null;
  const { rows } = await pool.query(`
    INSERT INTO published_assets(id,item_id,platform,external_id,url,title,published_at,last_synced_at,raw)
    VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8::jsonb)
    ON CONFLICT (platform,external_id) DO UPDATE SET
      updated_at=now(),
      item_id=COALESCE(published_assets.item_id,EXCLUDED.item_id),
      url=COALESCE(EXCLUDED.url,published_assets.url),
      title=COALESCE(EXCLUDED.title,published_assets.title),
      published_at=COALESCE(EXCLUDED.published_at,published_assets.published_at),
      last_synced_at=now(),
      raw=EXCLUDED.raw
    RETURNING *
  `, [randomUUID(), itemId, platform, String(externalId), url || null, title || null, publishedAt || null, JSON.stringify(raw || {})]);
  return rows[0];
}

async function saveSnapshot(asset, metrics, raw) {
  if (!pool || !asset) return null;
  const id = randomUUID();
  await pool.query(`
    INSERT INTO performance_events(
      id,asset_id,item_id,platform,published_at,views,reach,impressions,likes,comments,shares,saves,bookmarks,
      profile_clicks,subscribers_gained,watch_time_seconds,average_view_duration,completion_rate,raw
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
    )
  `, [
    id, asset.id, asset.item_id || null, asset.platform, asset.published_at || null,
    numeric(metrics.views), numeric(metrics.reach), numeric(metrics.impressions), numeric(metrics.likes),
    numeric(metrics.comments), numeric(metrics.shares), numeric(metrics.saves), numeric(metrics.bookmarks),
    numeric(metrics.profileClicks), numeric(metrics.subscribersGained), numeric(metrics.watchTimeSeconds),
    numeric(metrics.averageViewDuration), numeric(metrics.completionRate), JSON.stringify(raw || {})
  ]);
  return id;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data.error && (data.error.message || data.error)) || ('HTTP ' + response.status));
  return data;
}

async function syncInstagram() {
  if (!(process.env.INSTAGRAM_USER_ID && process.env.INSTAGRAM_ACCESS_TOKEN)) return { source:'instagram', skipped:true };
  const userId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const base = process.env.INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com';
  const apiVersion = process.env.INSTAGRAM_API_VERSION || 'v24.0';
  const mediaUrl = new URL(base.replace(/\/$/,'') + '/' + apiVersion + '/' + encodeURIComponent(userId) + '/media');
  mediaUrl.searchParams.set('fields','id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count');
  mediaUrl.searchParams.set('limit','50');
  mediaUrl.searchParams.set('access_token',token);
  const media = await fetchJson(mediaUrl);
  let synced = 0;
  for (const m of Array.isArray(media.data) ? media.data : []) {
    const metrics = { likes:m.like_count, comments:m.comments_count };
    const insightRaw = {};
    for (const metric of ['views','reach','saved','shares']) {
      try {
        const u = new URL(base.replace(/\/$/,'') + '/' + apiVersion + '/' + encodeURIComponent(m.id) + '/insights');
        u.searchParams.set('metric',metric);
        u.searchParams.set('access_token',token);
        const d = await fetchJson(u);
        const row = Array.isArray(d.data) ? d.data[0] : null;
        const value = row && (row.values?.[0]?.value ?? row.total_value?.value ?? row.value);
        insightRaw[metric] = d;
        if (metric === 'saved') metrics.saves = value;
        else metrics[metric] = value;
      } catch (error) {
        insightRaw[metric] = { error:error.message };
      }
    }
    const asset = await upsertAsset({
      platform:'instagram', externalId:m.id, url:m.permalink, title:(m.caption || '').slice(0,180),
      publishedAt:m.timestamp, raw:m
    });
    await saveSnapshot(asset, metrics, { media:m, insights:insightRaw });
    synced++;
  }
  return { source:'instagram', synced };
}

async function youtubeAccessToken() {
  const body = new URLSearchParams({
    client_id:process.env.YOUTUBE_CLIENT_ID || '',
    client_secret:process.env.YOUTUBE_CLIENT_SECRET || '',
    refresh_token:process.env.YOUTUBE_REFRESH_TOKEN || '',
    grant_type:'refresh_token'
  });
  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
  });
  return data.access_token;
}

async function syncYouTube() {
  if (!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN)) return { source:'youtube', skipped:true };
  const token = await youtubeAccessToken();
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86400000);
  const q = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  q.searchParams.set('ids','channel==MINE');
  q.searchParams.set('startDate',start.toISOString().slice(0,10));
  q.searchParams.set('endDate',end.toISOString().slice(0,10));
  q.searchParams.set('dimensions','video');
  q.searchParams.set('metrics','views,likes,comments,shares,subscribersGained,estimatedMinutesWatched,averageViewDuration');
  q.searchParams.set('sort','-views');
  q.searchParams.set('maxResults','200');
  const report = await fetchJson(q, { headers:{Authorization:'Bearer ' + token} });
  const headers = (report.columnHeaders || []).map(x => x.name);
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const ids = rows.map(r => String(r[0])).filter(Boolean);
  const snippets = {};
  for (let i=0;i<ids.length;i+=50) {
    const u = new URL('https://www.googleapis.com/youtube/v3/videos');
    u.searchParams.set('part','snippet');
    u.searchParams.set('id',ids.slice(i,i+50).join(','));
    const d = await fetchJson(u, { headers:{Authorization:'Bearer ' + token} });
    for (const item of Array.isArray(d.items)?d.items:[]) snippets[item.id]=item.snippet || {};
  }
  let synced=0;
  for (const row of rows) {
    const obj={};headers.forEach((h,i)=>obj[h]=row[i]);
    const id=String(obj.video);
    const sn=snippets[id] || {};
    const asset=await upsertAsset({
      platform:'youtube', externalId:id, url:'https://www.youtube.com/watch?v='+id,
      title:sn.title || id, publishedAt:sn.publishedAt || null, raw:{analytics:obj,snippet:sn}
    });
    await saveSnapshot(asset, {
      views:obj.views, likes:obj.likes, comments:obj.comments, shares:obj.shares,
      subscribersGained:obj.subscribersGained,
      watchTimeSeconds:numeric(obj.estimatedMinutesWatched) === null ? null : Number(obj.estimatedMinutesWatched)*60,
      averageViewDuration:obj.averageViewDuration
    }, obj);
    synced++;
  }
  return { source:'youtube', synced };
}

async function syncX() {
  if (!(process.env.X_USER_ID && process.env.X_BEARER_TOKEN)) return { source:'x', skipped:true };
  const u = new URL('https://api.x.com/2/users/' + encodeURIComponent(process.env.X_USER_ID) + '/tweets');
  u.searchParams.set('max_results','100');
  u.searchParams.set('exclude','retweets,replies');
  u.searchParams.set('tweet.fields','created_at,public_metrics,attachments');
  u.searchParams.set('expansions','attachments.media_keys');
  u.searchParams.set('media.fields','public_metrics,type');
  const d = await fetchJson(u,{headers:{Authorization:'Bearer '+process.env.X_BEARER_TOKEN}});
  let synced=0;
  for (const t of Array.isArray(d.data)?d.data:[]) {
    const pm=t.public_metrics || {};
    const asset=await upsertAsset({
      platform:'x', externalId:t.id, url:'https://x.com/i/web/status/'+t.id,
      title:(t.text||'').slice(0,180), publishedAt:t.created_at, raw:t
    });
    await saveSnapshot(asset,{
      views:pm.impression_count, impressions:pm.impression_count, likes:pm.like_count,
      comments:pm.reply_count, shares:(pm.retweet_count||0)+(pm.quote_count||0), bookmarks:pm.bookmark_count
    },t);
    synced++;
  }
  return { source:'x', synced };
}

async function syncReddit() {
  const username=String(process.env.REDDIT_USERNAME||'').trim();
  if (!username) return { source:'reddit', skipped:true };
  const u='https://www.reddit.com/user/'+encodeURIComponent(username)+'/submitted.json?limit=100&raw_json=1';
  const d=await fetchJson(u,{headers:{'User-Agent':'PsychologyContentOS/2.1 analytics'}});
  let synced=0;
  for(const child of d.data?.children || []) {
    const p=child.data || {};
    const asset=await upsertAsset({
      platform:'reddit', externalId:p.id, url:'https://www.reddit.com'+(p.permalink||''),
      title:p.title||p.id, publishedAt:p.created_utc ? new Date(p.created_utc*1000).toISOString() : null, raw:p
    });
    await saveSnapshot(asset,{likes:p.score,comments:p.num_comments},{score:p.score,upvote_ratio:p.upvote_ratio,num_comments:p.num_comments});
    synced++;
  }
  return { source:'reddit', synced };
}

let analyticsSyncRunning=false;
async function syncAnalyticsSources() {
  if (!pool || analyticsSyncRunning) return [];
  analyticsSyncRunning=true;
  const results=[];
  for (const fn of [syncInstagram,syncYouTube,syncX,syncReddit]) {
    try { results.push(await fn()); }
    catch (error) { results.push({ source:fn.name.replace(/^sync/,'').toLowerCase(), error:error.message }); }
  }
  analyticsSyncRunning=false;
  console.log('Analytics sync:', JSON.stringify(results));
  return results;
}

async function analyticsSummary() {
  if (!pool) return { sources:analyticsSourceState(), assets:[], totals:{} };
  const { rows:assets }=await pool.query(`
    SELECT a.*, p.views,p.reach,p.impressions,p.likes,p.comments,p.shares,p.saves,p.bookmarks,p.profile_clicks,
           p.subscribers_gained,p.watch_time_seconds,p.average_view_duration,p.completion_rate,p.created_at AS measured_at,
           i.title AS idea_title
    FROM published_assets a
    LEFT JOIN content_items i ON i.id=a.item_id
    LEFT JOIN LATERAL (
      SELECT * FROM performance_events pe WHERE pe.asset_id=a.id ORDER BY pe.created_at DESC LIMIT 1
    ) p ON true
    ORDER BY COALESCE(a.published_at,a.created_at) DESC
    LIMIT 250
  `);
  const { rows:[totals] }=await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (asset_id) * FROM performance_events WHERE asset_id IS NOT NULL ORDER BY asset_id,created_at DESC
    )
    SELECT
      COALESCE(SUM(views),0)::bigint AS views,
      COALESCE(SUM(likes),0)::bigint AS likes,
      COALESCE(SUM(comments),0)::bigint AS comments,
      COALESCE(SUM(shares),0)::bigint AS shares,
      COALESCE(SUM(saves),0)::bigint AS saves,
      COALESCE(SUM(bookmarks),0)::bigint AS bookmarks,
      COALESCE(SUM(subscribers_gained),0)::bigint AS subscribers_gained
    FROM latest
  `);
  return { sources:analyticsSourceState(), assets, totals:totals||{} };
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
      editorialModel: process.env.OPENAI_EDITORIAL_MODEL || 'gpt-5.6-terra',
      visualStyle: parseEnvJson('VISUAL_STYLE_JSON', {
        name: 'Leo Psychology Editorial',
        principles: ['dark editorial','conceptual not therapeutic','high contrast','large typography','negative space','cinematic restraint','one acid accent'],
        palette: ['#090A0C','#F4F5F7','#D9FF69'],
        carousel: { format: '1080x1350', slides: '6-9', density: 'one idea per slide' },
        gif: { frames: '4-8', loop: true, text: 'minimal' },
        avoid: ['pastel wellness aesthetics','stock therapy imagery','generic gradients','emoji-led self-help','busy infographics']
      })
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

  if (u.pathname === '/api/analytics/sources' && req.method === 'GET') {
    return json(res, 200, { sources: analyticsSourceState() });
  }

  if (u.pathname === '/api/analytics/summary' && req.method === 'GET') {
    return json(res, 200, await analyticsSummary());
  }

  if (u.pathname === '/api/analytics/link' && req.method === 'POST') {
    if (!pool) return json(res, 503, { error:'Database unavailable' });
    const body=await readJsonBody(req);
    const platform=String(body.platform||'').toLowerCase().trim();
    const url=String(body.url||'').trim();
    const externalId=String(body.externalId||externalIdFromUrl(platform,url)||'').trim();
    if (!platform || !externalId) return json(res,400,{error:'platform and recognizable URL/externalId required'});
    const asset=await upsertAsset({
      platform, externalId, url:url||null, title:body.title||null, publishedAt:body.publishedAt||null,
      itemId:body.itemId||null, raw:{manualLink:true}
    });
    return json(res,200,{ok:true,asset});
  }

  if (u.pathname === '/api/performance' && req.method === 'POST') {
    if (!pool) return json(res, 503, { error: 'Database unavailable' });
    const body = await readJsonBody(req);
    let asset=null;
    if (body.assetId) {
      const q=await pool.query('SELECT * FROM published_assets WHERE id=$1',[body.assetId]);asset=q.rows[0]||null;
    } else if (body.platform && (body.externalId || body.url)) {
      const externalId=body.externalId || externalIdFromUrl(body.platform,body.url);
      asset=await upsertAsset({platform:body.platform,externalId,url:body.url||null,title:body.title||null,publishedAt:body.publishedAt||null,itemId:body.itemId||null,raw:{manual:true}});
    }
    const id = asset
      ? await saveSnapshot(asset, body, body)
      : randomUUID();
    if (!asset) {
      await pool.query(`
        INSERT INTO performance_events(id,item_id,platform,published_at,views,reach,impressions,likes,comments,shares,saves,bookmarks,profile_clicks,subscribers_gained,watch_time_seconds,average_view_duration,completion_rate,raw)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
      `,[
        id,body.itemId||null,body.platform||'unknown',body.publishedAt||null,body.views??null,body.reach??null,body.impressions??null,
        body.likes??null,body.comments??null,body.shares??null,body.saves??null,body.bookmarks??null,body.profileClicks??null,
        body.subscribersGained??null,body.watchTimeSeconds??null,body.averageViewDuration??null,body.completionRate??null,JSON.stringify(body)
      ]);
    }
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
  .then(() => {
    const server=http.createServer((req,res) => route(req,res).catch(error => {
      console.error(error);
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message, code: error.code || null });
      else res.end();
    }));
    server.listen(port,'0.0.0.0',() => {
      console.log('Psychology Content OS v2.1 running on ' + port);
      setTimeout(() => syncAnalyticsSources().catch(error => console.error('Initial analytics sync failed:',error.message)), 15000);
      const minutes=Math.max(60,Number(process.env.ANALYTICS_SYNC_MINUTES||360));
      setInterval(() => syncAnalyticsSources().catch(error => console.error('Analytics sync failed:',error.message)), minutes*60000);
    });
  })
  .catch(error => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
