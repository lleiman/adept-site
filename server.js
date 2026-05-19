// ============================================================
//  ADEPT site — static server + edit API
//
//  Endpoints:
//    GET  /              → index.html
//    GET  /case          → case.html
//    GET  /portfolio     → portfolio.html
//    GET  /api/content   → current overrides (from ./content.json)
//    POST /api/content   → save overrides (requires admin password)
//    POST /api/upload    → save a base64 image to ./uploads/<name>, return url
//    Static: any other path under project root
//
//  Persistence: edits live in $DATA_DIR (defaults to ./ for local dev).
//  On Railway set DATA_DIR=/data and mount a Volume at /data — then
//  content.json and uploads/ survive every redeploy.
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ADEPT";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

console.log(`ADEPT data dir: ${DATA_DIR}`);

app.use(express.json({ limit: "15mb" }));

// ---- server-side render helpers ----
function vimeoBackgroundSrc(vimeo) {
  if (!vimeo || !vimeo.id) return null;
  const h = vimeo.hash ? `h=${encodeURIComponent(vimeo.hash)}&` : "";
  return `https://player.vimeo.com/video/${vimeo.id}?${h}background=1&autoplay=1&loop=1&muted=1&autopause=0`;
}
function applyServerTemplates(html, content) {
  const ui = (content && content.ui) || {};
  const attrs = [];
  if (ui.navFont && ui.navFont !== "unbounded-caps") attrs.push(`data-nav-font="${ui.navFont}"`);
  if (ui.brandStyle && ui.brandStyle !== "tag-lime") attrs.push(`data-brand-style="${ui.brandStyle}"`);
  if (ui.ctaStyle && ui.ctaStyle !== "center") attrs.push(`data-cta-style="${ui.ctaStyle}"`);
  if (attrs.length) {
    html = html.replace(/<body(\s|>)/, `<body ${attrs.join(" ")}$1`);
  }
  return html;
}
function serveHtml(filename) {
  return (req, res) => {
    fs.readFile(path.join(ROOT, filename), "utf8", (err, html) => {
      if (err) return res.status(500).send("read failed");
      const content = readContent();
      // Hero video injection on index.html only
      if (filename === "index.html") {
        const src = vimeoBackgroundSrc(content && content.hero && content.hero.vimeo);
        if (src) {
          html = html.replace(
            /<div class="pic" data-edit-img="hero" data-video-mode="background"[^>]*><\/div>/,
            `<div class="pic" data-edit-img="hero" data-video-mode="background" style="background:none"><iframe class="adept-video" src="${src}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`
          );
        }
      }
      html = applyServerTemplates(html, content);
      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    });
  };
}

app.get("/", serveHtml("index.html"));
app.get("/case", serveHtml("case.html"));
app.get("/portfolio", serveHtml("portfolio.html"));

// ---- content API ----
function readContent() {
  try { return JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8")); }
  catch { return {}; }
}
function writeContent(data) {
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/content", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(readContent());
});

app.post("/api/content", (req, res) => {
  const { password, content } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "auth" });
  if (typeof content !== "object" || content === null) return res.status(400).json({ error: "bad payload" });
  try { writeContent(content); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "write failed" }); }
});

// ---- image upload (base64 → file in /uploads) ----
app.post("/api/upload", (req, res) => {
  const { password, dataUrl } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "auth" });
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return res.status(400).json({ error: "bad image" });
  }
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "bad image format" });
  const ext = m[1].toLowerCase().replace("jpeg", "jpg");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: "too big" });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
    res.json({ url: `/uploads/${name}` });
  } catch (e) { console.error(e); res.status(500).json({ error: "write failed" }); }
});

// ---- password sanity check (no leak) ----
app.post("/api/check", (req, res) => {
  const { password } = req.body || {};
  res.json({ ok: password === ADMIN_PASSWORD });
});

// ---- uploaded images live in the data dir (so they survive redeploys) ----
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "1d" }));

// ---- static files (must be after /api and /uploads routes) ----
app.use(express.static(ROOT, { extensions: ["html"] }));

// ---- 404 fallback ----
app.use((req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => console.log(`ADEPT listening on ${PORT}`));
