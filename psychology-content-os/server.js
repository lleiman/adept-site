const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 3000);
const root = path.join(__dirname, 'public');
const trendSource = process.env.TREND_SOURCE_URL || 'https://consciousness-digest-production.up.railway.app/trend-data.json';

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

async function loadTrends() {
  const fallback = parseEnvJson('TREND_FALLBACK_JSON', []);
  try {
    const response = await fetch(trendSource, {
      headers: { 'User-Agent': 'psychology-content-os/1.0' },
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

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/trends') {
      const trends = await loadTrends();
      return json(res, 200, { updatedAt: new Date().toISOString(), trends });
    }

    if (u.pathname === '/api/packs') {
      const packs = parseEnvJson('CONTENT_PIPELINE_JSON', []);
      return json(res, 200, { updatedAt: new Date().toISOString(), packs: Array.isArray(packs) ? packs : [] });
    }

    if (u.pathname === '/api/config') {
      return json(res, 200, {
        timezone: process.env.CONTENT_TIMEZONE || 'Asia/Makassar',
        cadence: {
          telegram: '1 strong post/day',
          instagram: '1 reel/day',
          youtubeShorts: 'same vertical idea',
          youtubeLong: '1 thesis video/week',
          x: '2–4 thoughts/day',
          reddit: '2–3 substantive interactions/week'
        }
      });
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
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Server error' });
  }
}).listen(port, '0.0.0.0', () => {
  console.log('Psychology Content OS running on ' + port);
});