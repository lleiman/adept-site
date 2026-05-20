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
  if (ui.logoStyle && ui.logoStyle !== "lime-text") attrs.push(`data-logo="${ui.logoStyle}"`);
  if (attrs.length) {
    html = html.replace(/<body(\s|>)/, `<body ${attrs.join(" ")}$1`);
  }
  // CSS variables for scrim opacity — injected before </head> for first paint
  const cssVars = [];
  if (typeof ui.scrimHero  === "number") cssVars.push(`--scrim-hero: ${ui.scrimHero / 100}`);
  if (typeof ui.scrimCases === "number") cssVars.push(`--scrim-cases: ${ui.scrimCases / 100}`);
  if (cssVars.length) {
    html = html.replace(
      /<\/head>/,
      `<style>:root { ${cssVars.join("; ")}; }</style></head>`
    );
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
        const heroVimeo = content && content.hero && content.hero.vimeo;
        const src = vimeoBackgroundSrc(heroVimeo);
        if (src) {
          // Use the cached Vimeo thumbnail as a static poster so the
          // first paint shows the first frame instead of black while
          // the iframe boots up.
          const poster = heroVimeo && heroVimeo.thumb
            ? `style="background-image:url('${heroVimeo.thumb}');background-size:cover;background-position:center"`
            : `style="background:none"`;
          html = html.replace(
            /<div class="pic" data-edit-img="hero" data-video-mode="background"[^>]*><\/div>/,
            `<div class="pic" data-edit-img="hero" data-video-mode="background" ${poster}><iframe class="adept-video" src="${src}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`
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

// ---- Vimeo poster cache ----
// For any vimeo entry without a `thumb` field, fetch the first-frame
// preview via Vimeo's oEmbed API, download it to /uploads/, and store
// the local URL so it survives forever in the data volume.
async function ensureVimeoThumb(vimeo) {
  if (!vimeo || typeof vimeo !== "object" || !vimeo.id || vimeo.thumb) return;
  try {
    const inputUrl = vimeo.hash
      ? `https://vimeo.com/${vimeo.id}/${vimeo.hash}`
      : `https://vimeo.com/${vimeo.id}`;
    const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(inputUrl)}&width=1920`;
    const oembedRes = await fetch(oembedUrl, { headers: { "User-Agent": "adept-site" } });
    if (!oembedRes.ok) { console.warn("oEmbed", oembedRes.status, vimeo.id); return; }
    const meta = await oembedRes.json();
    const thumbUrl = meta && meta.thumbnail_url;
    if (!thumbUrl) return;

    const imgRes = await fetch(thumbUrl);
    if (!imgRes.ok) return;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const extMatch = thumbUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
    const ext = (extMatch ? extMatch[1] : "jpg").toLowerCase().replace("jpeg", "jpg");
    const filename = `vimeo-${vimeo.id}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    vimeo.thumb = `/uploads/${filename}`;
    console.log(`Cached vimeo thumb ${vimeo.id} -> ${vimeo.thumb} (${buf.length} bytes)`);
  } catch (e) {
    console.warn("ensureVimeoThumb error:", e.message, e.cause && e.cause.message);
  }
}

// Walk the content tree and fill in `.thumb` for every vimeo entry
async function ensureAllVimeoThumbs(content) {
  if (!content || typeof content !== "object") return;
  await ensureVimeoThumb(content.hero && content.hero.vimeo);
  const cases = content.cases || {};
  for (const id of Object.keys(cases)) {
    await ensureVimeoThumb(cases[id] && cases[id].vimeo);
  }
  const details = content.details || {};
  for (const id of Object.keys(details)) {
    const gallery = (details[id] && details[id].gallery) || [];
    for (let i = 0; i < gallery.length; i++) {
      await ensureVimeoThumb(gallery[i] && gallery[i].vimeo);
    }
  }
}

app.post("/api/content", async (req, res) => {
  const { password, content } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "auth" });
  if (typeof content !== "object" || content === null) return res.status(400).json({ error: "bad payload" });
  try {
    await ensureAllVimeoThumbs(content);
    writeContent(content);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "write failed" }); }
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
app.use(express.static(ROOT, {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    // Force browsers to revalidate JS/CSS on every load — keeps Safari
    // from serving a stale stylesheet after we deploy a fix.
    if (/\.(css|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// ---- 404 fallback ----
app.use((req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => console.log(`ADEPT listening on ${PORT}`));
