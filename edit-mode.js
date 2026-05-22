// ============================================================
//  ADEPT — inline edit mode (shared across pages)
//
//  Toggle with ⌘B (Mac) or Ctrl+B. On first toggle in a session
//  prompts for admin password; valid password caches in
//  sessionStorage so subsequent toggles are immediate.
//
//  Editable surfaces:
//    [data-edit="path.to.field"]      contentEditable text
//    [data-edit-img="path.prefix"]    background-image swap
//
//  Edits POST to /api/content (server writes ./content.json).
//  Images POST to /api/upload (server writes ./uploads/<file>,
//  returns a public URL stored in content.<prefix>.img).
//
//  Pages call window.AdeptEdit.apply() after re-rendering
//  dynamic content (e.g. case.html on hashchange) so overrides
//  re-apply to the new DOM.
// ============================================================

(function () {
  const body = document.body;
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
  let content = {};
  let password = sessionStorage.getItem("adept-auth") || "";
  let saveTimer = 0;
  let savingEl = null;

  // ---- nested-path helpers ----
  function getPath(obj, path) {
    const parts = path.split(".");
    let o = obj;
    for (const p of parts) {
      if (!o || typeof o !== "object") return undefined;
      o = o[p];
    }
    return o;
  }
  function setPath(obj, path, value) {
    const parts = path.split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof o[key] !== "object" || o[key] === null) o[key] = isNaN(parts[i + 1]) ? {} : [];
      o = o[key];
    }
    o[parts[parts.length - 1]] = value;
  }
  function unsetPath(obj, path) {
    const parts = path.split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o || typeof o !== "object" || !(parts[i] in o)) return;
      o = o[parts[i]];
    }
    if (o) delete o[parts[parts.length - 1]];
  }

  // ---- API ----
  async function fetchContent() {
    try {
      const r = await fetch("/api/content", { cache: "no-store" });
      content = (await r.json()) || {};
    } catch (e) { console.warn("fetch content:", e); content = {}; }
    applyOverrides();
    // Let dynamic pages (case.html) re-render with the new content
    window.dispatchEvent(new Event("adept-content-loaded"));
  }
  async function saveContent() {
    if (!password) return false;
    showSaving(true);
    try {
      const r = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, content })
      });
      if (!r.ok) {
        if (r.status === 401) {
          password = "";
          sessionStorage.removeItem("adept-auth");
          alert("Пароль больше не действителен");
        }
        showSaving(false);
        return false;
      }
      showSaving(false, "сохранено");
      return true;
    } catch (e) { console.error(e); showSaving(false); return false; }
  }
  async function uploadImage(dataUrl) {
    if (!password) return null;
    try {
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, dataUrl })
      });
      if (!r.ok) {
        if (r.status === 401) { password = ""; sessionStorage.removeItem("adept-auth"); }
        alert("Загрузка не удалась");
        return null;
      }
      const { url } = await r.json();
      return url;
    } catch (e) { console.error(e); return null; }
  }
  async function checkPassword(pw) {
    try {
      const r = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw })
      });
      const { ok } = await r.json();
      return !!ok;
    } catch (e) { return false; }
  }

  function showSaving(on, msg) {
    if (!savingEl) savingEl = document.getElementById("edit-saving");
    if (!savingEl) return;
    savingEl.textContent = msg || "сохраняю…";
    savingEl.style.display = on || msg ? "" : "none";
    if (msg) {
      clearTimeout(showSaving._t);
      showSaving._t = setTimeout(() => { savingEl.style.display = "none"; }, 1400);
    }
  }

  // Debounced save — multiple rapid edits batch into one POST
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveContent, 200);
  }

  // ---- Vimeo helpers ----
  function parseVimeoInput(input) {
    if (!input) return null;
    const s = String(input).trim();
    // 1. iframe embed code or player URL
    let m = s.match(/player\.vimeo\.com\/video\/(\d+)(?:[?&]h=([a-zA-Z0-9]+))?/);
    if (m) return { id: m[1], hash: m[2] || "" };
    // 2. vimeo.com/123 or vimeo.com/123/abc
    m = s.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?/);
    if (m) return { id: m[1], hash: m[2] || "" };
    // 3. plain numeric ID
    m = s.match(/^(\d{6,})$/);
    if (m) return { id: m[1], hash: "" };
    return null;
  }
  function vimeoSrc(vimeo, mode) {
    if (!vimeo || !vimeo.id) return null;
    const h = vimeo.hash ? `h=${encodeURIComponent(vimeo.hash)}&` : "";
    const params = mode === "background"
      ? "background=1&autoplay=1&loop=1&muted=1&autopause=0"
      : "title=0&byline=0&portrait=0&dnt=1";
    return `https://player.vimeo.com/video/${vimeo.id}?${h}${params}`;
  }

  // ---- nav font variant ----
  function applyNavFont() {
    const variant = getPath(content, "ui.navFont") || "unbounded-caps";
    if (variant === "unbounded-caps") {
      delete document.body.dataset.navFont;
    } else {
      document.body.dataset.navFont = variant;
    }
    document.querySelectorAll(".edit-font-picker button[data-font]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.font === variant ? "true" : "false");
    });
  }

  // ---- brand-tag variant ----
  function applyBrandStyle() {
    const variant = getPath(content, "ui.brandStyle") || "tag-lime";
    if (variant === "tag-lime") {
      delete document.body.dataset.brandStyle;
    } else {
      document.body.dataset.brandStyle = variant;
    }
    document.querySelectorAll(".edit-brand-picker button[data-brand]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.brand === variant ? "true" : "false");
    });
  }

  // ---- hover-cta variant ----
  function applyCtaStyle() {
    const variant = getPath(content, "ui.ctaStyle") || "center";
    if (variant === "center") {
      delete document.body.dataset.ctaStyle;
    } else {
      document.body.dataset.ctaStyle = variant;
    }
    document.querySelectorAll(".edit-cta-picker button[data-cta]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.cta === variant ? "true" : "false");
    });
  }

  // ---- cta block layout ----
  function applyCtaLayout() {
    const variant = getPath(content, "ui.ctaLayout") || "strip";
    if (variant === "strip") {
      delete document.body.dataset.ctaLayout;
    } else {
      document.body.dataset.ctaLayout = variant;
    }
    document.querySelectorAll(".edit-ctalayout-picker button[data-cta-layout]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.ctaLayout === variant ? "true" : "false");
    });
  }

  // ---- logo variant ----
  function applyLogoStyle() {
    const variant = getPath(content, "ui.logoStyle") || "lime-text";
    if (variant === "lime-text") {
      delete document.body.dataset.logo;
    } else {
      document.body.dataset.logo = variant;
    }
    document.querySelectorAll(".edit-logo-picker button[data-logo]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.logo === variant ? "true" : "false");
    });
  }

  // ---- scrim opacity sliders (hero + cases) ----
  function applyScrimSettings() {
    const root = document.documentElement.style;
    const hero  = getPath(content, "ui.scrimHero");
    const cases = getPath(content, "ui.scrimCases");
    if (hero  != null) root.setProperty("--scrim-hero",  hero  / 100);
    else root.removeProperty("--scrim-hero");
    if (cases != null) root.setProperty("--scrim-cases", cases / 100);
    else root.removeProperty("--scrim-cases");
    // Mirror values into slider inputs + their text readout
    document.querySelectorAll('input[type="range"][data-scrim]').forEach(input => {
      const key = input.dataset.scrim;
      const v = (key === "hero") ? hero : cases;
      const defaults = { hero: 45, cases: 78 };
      input.value = v != null ? v : defaults[key];
      const display = document.querySelector(`[data-scrim-val="${key}"]`);
      if (display) display.textContent = input.value;
    });
  }

  // ---- mobile burger menu ----
  function wireBurger() {
    const burger = document.querySelector(".header-burger");
    if (!burger || burger.dataset.wired === "1") return;
    burger.dataset.wired = "1";
    const close = () => document.body.classList.remove("menu-open");
    burger.addEventListener("click", () => {
      document.body.classList.toggle("menu-open");
    });
    document.querySelectorAll(".header-nav a").forEach(a => {
      a.addEventListener("click", close);
    });
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") close();
    });
  }

  // ---- card hover → autoplay vimeo preview ----
  // Pre-creates iframes immediately on page load so the Vimeo player
  // is fully buffered by the time the user hovers. Uses Vimeo Player
  // SDK (loaded via <script> in <head>) to pause/play instantly with
  // no network round-trip on the hover event itself.
  function vimeoSDK() {
    return new Promise(resolve => {
      if (window.Vimeo && window.Vimeo.Player) return resolve(window.Vimeo);
      const check = setInterval(() => {
        if (window.Vimeo && window.Vimeo.Player) {
          clearInterval(check); resolve(window.Vimeo);
        }
      }, 100);
    });
  }

  async function wireCardHover() {
    const candidates = [];
    document.querySelectorAll(".case[data-id]").forEach(card => {
      if (card.dataset.hoverWired === "1") return;
      const id = card.dataset.id;
      const vimeo = getPath(content, `cases.${id}.vimeo`);
      if (!vimeo || !vimeo.id) return;
      const pic = card.querySelector(".pic");
      if (!pic) return;
      card.dataset.hoverWired = "1";

      // Build the iframe NOW (background mode autoplays muted+loop; we
      // pause it as soon as the SDK reports the player is loaded, so by
      // hover-time the player + first video frames are already buffered)
      const hash = vimeo.hash ? `h=${encodeURIComponent(vimeo.hash)}&` : "";
      const ifr = document.createElement("iframe");
      ifr.className = "hover-video";
      ifr.src = `https://player.vimeo.com/video/${vimeo.id}?${hash}background=1&autoplay=1&loop=1&muted=1&autopause=0&dnt=1`;
      ifr.allow = "autoplay; fullscreen; picture-in-picture";
      ifr.allowFullscreen = true;
      pic.appendChild(ifr);

      candidates.push({ card, ifr });
    });

    if (!candidates.length) return;
    const Vimeo = await vimeoSDK();

    candidates.forEach(({ card, ifr }) => {
      const player = new Vimeo.Player(ifr);
      let preloaded = false;
      let pendingPlay = false;
      // Pause as soon as the player has loaded (autoplay had time to
      // buffer the first frames, now keep it idle until hover)
      player.on("loaded", () => {
        preloaded = true;
        if (!pendingPlay) player.pause().catch(() => {});
      });
      card.addEventListener("mouseenter", () => {
        card.classList.add("is-playing");
        if (preloaded) player.play().catch(() => {});
        else pendingPlay = true; // play once loaded
      });
      card.addEventListener("mouseleave", () => {
        card.classList.remove("is-playing");
        pendingPlay = false;
        player.pause().catch(() => {});
      });
    });
  }

  // ---- apply overrides to current DOM ----
  function applyOverrides() {
    applyNavFont();
    applyBrandStyle();
    applyCtaStyle();
    applyCtaLayout();
    applyLogoStyle();
    applyScrimSettings();
    wireBurger();
    wireCardHover();
    document.querySelectorAll("[data-edit]").forEach(el => {
      const v = getPath(content, el.dataset.edit);
      if (typeof v === "string" && el.textContent !== v) el.textContent = v;
    });
    document.querySelectorAll("[data-edit-img]").forEach(el => {
      const prefix = el.dataset.editImg;
      const imgUrl = getPath(content, prefix + ".img");
      const vimeo = getPath(content, prefix + ".vimeo");
      const videoMode = el.dataset.videoMode; // "background" | "player" | undefined
      // Poster priority for the .pic background: user-uploaded img >
      // cached vimeo thumbnail. The poster sits behind the iframe and
      // shows as a static first-frame placeholder while the player loads.
      const poster = imgUrl || (vimeo && vimeo.thumb) || "";

      if (el.dataset.origBg === undefined) {
        el.dataset.origBg = el.style.backgroundImage || "";
        el.dataset.origFilter = el.style.filter || "";
      }

      const old = el.querySelector(":scope > iframe.adept-video");
      const setPoster = () => {
        if (poster) {
          el.style.backgroundImage = `url('${poster}')`;
          el.style.backgroundSize = "cover";
          el.style.backgroundPosition = "center";
          el.style.filter = "none";
        } else {
          el.style.backgroundImage = el.dataset.origBg || "none";
          el.style.filter = el.dataset.origFilter || "";
        }
      };

      // If video mode + vimeo set → render iframe over the slot, with
      // the cached thumbnail underneath as a no-flash first-frame poster.
      if (videoMode && vimeo && vimeo.id) {
        const wantedSrc = vimeoSrc(vimeo, videoMode);
        if (!old || old.src !== wantedSrc) {
          if (old) old.remove();
          const ifr = document.createElement("iframe");
          ifr.className = "adept-video";
          ifr.src = wantedSrc;
          ifr.allow = "autoplay; fullscreen; picture-in-picture; clipboard-write";
          ifr.allowFullscreen = true;
          el.appendChild(ifr);
        }
        setPoster();
        return;
      }

      // No video mode on this slot → remove any leftover adept-video iframe
      // (the .hover-video iframes used by card-hover are a separate class
      //  and aren't touched here).
      if (old) old.remove();
      setPoster();
    });
  }

  // ---- drag-and-drop case reordering (edit-mode only) ----
  let dragSrcId = null;
  function setCardsDraggable(on) {
    document.querySelectorAll(".case[data-id]").forEach(card => {
      if (on) card.setAttribute("draggable", "true");
      else card.setAttribute("draggable", "false");
    });
  }
  document.addEventListener("dragstart", (e) => {
    if (!body.classList.contains("edit-mode")) return;
    if (e.target.matches && (e.target.matches("[data-edit]") || e.target.closest("[data-edit], .edt-img-ctl"))) {
      e.preventDefault(); return;
    }
    const card = e.target.closest && e.target.closest(".case[data-id]");
    if (!card) return;
    dragSrcId = card.dataset.id;
    card.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragSrcId); } catch (_) {}
    }
  });
  document.addEventListener("dragover", (e) => {
    if (!body.classList.contains("edit-mode") || !dragSrcId) return;
    const card = e.target.closest && e.target.closest(".case[data-id]");
    if (!card || card.classList.contains("dragging")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".case.drag-over").forEach(c => {
      if (c !== card) c.classList.remove("drag-over");
    });
    card.classList.add("drag-over");
  });
  document.addEventListener("dragleave", (e) => {
    const card = e.target.closest && e.target.closest(".case[data-id]");
    if (card && !card.contains(e.relatedTarget)) card.classList.remove("drag-over");
  });
  document.addEventListener("drop", async (e) => {
    if (!body.classList.contains("edit-mode") || !dragSrcId) return;
    e.preventDefault();
    const targetCard = e.target.closest && e.target.closest(".case[data-id]");
    if (!targetCard) { cleanupDrag(); return; }
    const targetId = targetCard.dataset.id;
    if (targetId === dragSrcId) { cleanupDrag(); return; }

    const order = window.adeptGetOrder ? window.adeptGetOrder() : null;
    if (!Array.isArray(order)) { cleanupDrag(); return; }
    const draggedIdx = order.indexOf(dragSrcId);
    if (draggedIdx < 0) { cleanupDrag(); return; }
    order.splice(draggedIdx, 1);
    const newTargetIdx = order.indexOf(targetId);
    if (newTargetIdx < 0) { cleanupDrag(); return; }
    order.splice(newTargetIdx, 0, dragSrcId);

    setPath(content, "ui.order", order);
    await saveContent();
    cleanupDrag();
    if (typeof window.adeptRenderCases === "function") {
      window.adeptRenderCases();
      setCardsDraggable(true); // freshly rendered cards need draggable too
    }
  });
  document.addEventListener("dragend", () => { cleanupDrag(); });
  function cleanupDrag() {
    document.querySelectorAll(".case.dragging, .case.drag-over").forEach(c => {
      c.classList.remove("dragging", "drag-over");
    });
    dragSrcId = null;
  }

  // ---- mode toggle (password-gated) ----
  async function ensureAuth() {
    if (password) return true;
    const input = prompt("Пароль администратора:");
    if (input === null || input === "") return false;
    const ok = await checkPassword(input);
    if (!ok) { alert("Неверный пароль"); return false; }
    password = input;
    sessionStorage.setItem("adept-auth", password);
    return true;
  }
  async function setMode(on) {
    if (on && !(await ensureAuth())) return;
    body.classList.toggle("edit-mode", on);
    document.querySelectorAll("[data-edit]").forEach(el => {
      el.contentEditable = on ? "true" : "false";
      el.spellcheck = false;
    });
    setCardsDraggable(on);
    // Re-render so hidden cases appear in edit-mode and disappear out of it.
    if (typeof window.adeptRenderCases === "function") window.adeptRenderCases();
    window.dispatchEvent(new Event("adept-content-loaded"));
  }
  function toggle() { return setMode(!body.classList.contains("edit-mode")); }

  // ---- keyboard ----
  window.addEventListener("keydown", e => {
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (cmd && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggle();
    } else if (e.key === "Escape" && body.classList.contains("edit-mode")) {
      const tgt = e.target;
      if (tgt && tgt.matches && tgt.matches("[data-edit]")) { tgt.blur(); return; }
      setMode(false);
    }
  });

  // ---- text save on blur ----
  document.addEventListener("blur", e => {
    if (!e.target.matches || !e.target.matches("[data-edit]")) return;
    if (!body.classList.contains("edit-mode")) return;
    const path = e.target.dataset.edit;
    const text = e.target.textContent.trim();
    if (text) setPath(content, path, text);
    else { unsetPath(content, path); applyOverrides(); }
    queueSave();
  }, true);
  document.addEventListener("keydown", e => {
    if (!e.target.matches || !e.target.matches("[data-edit]")) return;
    if (!body.classList.contains("edit-mode")) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
  });

  // ---- suppress link navigation while editing ----
  document.addEventListener("click", e => {
    if (!body.classList.contains("edit-mode")) return;
    if (e.target.closest(".edt-img-ctl, [data-edit], .edit-bar")) return;
    const link = e.target.closest("a[href]");
    if (link) e.preventDefault();
  }, true);

  // ---- image replace / reset ----
  document.addEventListener("click", async e => {
    const btn = e.target.closest(".edt-img-ctl button");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const target = btn.dataset.imgTarget;
    const action = btn.dataset.imgAction;
    if (action === "replace") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert("Файл больше 8 МБ"); return; }
        const dataUrl = await fileToDataURL(file);
        showSaving(true);
        const url = await uploadImage(dataUrl);
        if (!url) { showSaving(false); return; }
        setPath(content, `${target}.img`, url);
        await saveContent();
        applyOverrides();
      };
      input.click();
    } else if (action === "vimeo") {
      const cur = getPath(content, `${target}.vimeo`);
      const current = cur && cur.id ? `https://vimeo.com/${cur.id}${cur.hash ? "/" + cur.hash : ""}` : "";
      const raw = prompt("Вставь Vimeo URL / ID / embed-код\n(пусто = убрать видео):", current);
      if (raw === null) return; // cancelled
      if (raw.trim() === "") {
        unsetPath(content, `${target}.vimeo`);
      } else {
        const parsed = parseVimeoInput(raw);
        if (!parsed) { alert("Не удалось распознать ссылку Vimeo"); return; }
        setPath(content, `${target}.vimeo`, parsed);
      }
      await saveContent();
      applyOverrides();
    } else if (action === "reset") {
      unsetPath(content, `${target}.img`);
      unsetPath(content, `${target}.vimeo`);
      await saveContent();
      applyOverrides();
    } else if (action === "hide" || action === "show") {
      // target is "cases.<id>" → strip the prefix
      const id = String(target).replace(/^cases\./, "");
      if (!id) return;
      const cur = (getPath(content, "ui.hiddenCases") || []).filter(x => x !== id);
      if (action === "hide") cur.push(id);
      setPath(content, "ui.hiddenCases", cur);
      await saveContent();
      if (typeof window.adeptRenderCases === "function") window.adeptRenderCases();
      // case.html listens for this to re-render the «next cases» grid
      window.dispatchEvent(new Event("adept-content-loaded"));
    }
  });

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // ---- toolbar ----
  document.addEventListener("click", async e => {
    if (e.target.closest("#edit-done")) setMode(false);
    if (e.target.closest("#edit-reset")) {
      if (!confirm("Сбросить все правки? Это удалит content.json на сервере.")) return;
      content = {};
      await saveContent();
      location.reload();
    }
    const fontBtn = e.target.closest(".edit-font-picker button[data-font]");
    if (fontBtn) {
      setPath(content, "ui.navFont", fontBtn.dataset.font);
      applyNavFont();
      await saveContent();
    }
    const brandBtn = e.target.closest(".edit-brand-picker button[data-brand]");
    if (brandBtn) {
      setPath(content, "ui.brandStyle", brandBtn.dataset.brand);
      applyBrandStyle();
      await saveContent();
    }
    const ctaBtn = e.target.closest(".edit-cta-picker button[data-cta]");
    if (ctaBtn) {
      setPath(content, "ui.ctaStyle", ctaBtn.dataset.cta);
      applyCtaStyle();
      await saveContent();
    }
    const logoBtn = e.target.closest(".edit-logo-picker button[data-logo]");
    if (logoBtn) {
      setPath(content, "ui.logoStyle", logoBtn.dataset.logo);
      applyLogoStyle();
      await saveContent();
    }
    const ctaLayoutBtn = e.target.closest(".edit-ctalayout-picker button[data-cta-layout]");
    if (ctaLayoutBtn) {
      setPath(content, "ui.ctaLayout", ctaLayoutBtn.dataset.ctaLayout);
      applyCtaLayout();
      await saveContent();
    }
  });

  // Scrim sliders: live-update CSS on `input`, save on `change`
  document.addEventListener("input", (e) => {
    const inp = e.target.closest('input[type="range"][data-scrim]');
    if (!inp) return;
    const key = inp.dataset.scrim;
    const path = key === "hero" ? "ui.scrimHero" : "ui.scrimCases";
    setPath(content, path, parseInt(inp.value, 10));
    applyScrimSettings();
  });
  document.addEventListener("change", async (e) => {
    const inp = e.target.closest('input[type="range"][data-scrim]');
    if (!inp) return;
    await saveContent();
  });

  // ============================================================
  //  Case constructor (modal triggered from edit-bar)
  //  Lives entirely in this file so all three pages share it.
  //  Writes to content.customCases.<id>; getAllCases() in each
  //  page merges those into the rendered grid.
  // ============================================================
  const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

  function injectCaseBuilderUI() {
    const bar = document.querySelector(".edit-bar");
    // Inject CTA layout picker (3 variants) right before the spacer
    if (bar && !bar.querySelector(".edit-ctalayout-picker")) {
      const spacer = bar.querySelector(".spacer");
      const wrap = document.createElement("span");
      wrap.className = "edit-ctalayout-picker";
      wrap.innerHTML = `
        <span class="label">Контакты:</span>
        <button data-cta-layout="strip"      title="A · полосой внизу (по-умолч.)">A</button>
        <button data-cta-layout="under-form" title="B · под формой (справа)">B</button>
        <button data-cta-layout="under-text" title="C · под описанием (слева)">C</button>
      `;
      if (spacer) bar.insertBefore(wrap, spacer);
      else bar.appendChild(wrap);
    }
    if (bar && !bar.querySelector("#edit-add-case")) {
      const spacer = bar.querySelector(".spacer");
      // "+ Кейс" — open the case constructor modal
      const btnAdd = document.createElement("button");
      btnAdd.id = "edit-add-case";
      btnAdd.type = "button";
      btnAdd.className = "ghost cb-trigger";
      btnAdd.textContent = "+ Кейс";
      if (spacer) bar.insertBefore(btnAdd, spacer);
      else bar.appendChild(btnAdd);
      // "Обновить превью" — clear cached Vimeo first-frame jpgs and re-fetch
      const btnRefresh = document.createElement("button");
      btnRefresh.id = "edit-refresh-thumbs";
      btnRefresh.type = "button";
      btnRefresh.className = "ghost cb-trigger";
      btnRefresh.textContent = "↻ Превью Vimeo";
      btnRefresh.title = "Перевыкачать первые кадры из Vimeo (если ты обновил постер в Vimeo)";
      if (spacer) bar.insertBefore(btnRefresh, spacer);
      else bar.appendChild(btnRefresh);
    }
    if (document.getElementById("case-builder")) return;
    const m = document.createElement("div");
    m.id = "case-builder";
    m.className = "case-builder";
    m.hidden = true;
    m.innerHTML = `
      <div class="cb-backdrop" data-cb-close></div>
      <div class="cb-panel" role="dialog" aria-modal="true" aria-labelledby="cb-title">
        <header class="cb-head">
          <h2 id="cb-title">Кейсы — конструктор</h2>
          <button type="button" class="cb-x" data-cb-close aria-label="Закрыть">×</button>
        </header>
        <nav class="cb-tabs">
          <button type="button" class="cb-tab active" data-tab="list">Существующие</button>
          <button type="button" class="cb-tab" data-tab="form">+ Новый кейс</button>
        </nav>
        <section class="cb-view cb-view-list">
          <div class="cb-list"></div>
        </section>
        <form class="cb-view cb-view-form" hidden>
          <div class="cb-grid">
            <label class="cb-fld">
              <span>ID <em>(латиница, цифры, дефис)</em></span>
              <input name="id" pattern="[a-z0-9\\-]+" required placeholder="amnyamania">
            </label>
            <label class="cb-fld">
              <span>Бренд</span>
              <input name="brand" required placeholder="Пятёрочка">
            </label>
            <label class="cb-fld cb-fld-wide">
              <span>Заголовок</span>
              <input name="title" required placeholder="Амнямания 2 — детская кампания">
            </label>
            <label class="cb-fld cb-fld-wide">
              <span>Eyebrow <em>(мини-заголовок над тайтлом)</em></span>
              <input name="eyebrow" placeholder="CG-АНИМАЦИЯ · ПЯТЁРОЧКА">
            </label>
            <label class="cb-fld">
              <span>Категория</span>
              <select name="category">
                <option value="video">AI-видео</option>
                <option value="visual">Визуал & статика</option>
                <option value="installation">Инсталляции</option>
                <option value="tender">Тендеры</option>
                <option value="format">Форматы</option>
              </select>
            </label>
            <label class="cb-fld">
              <span>Hue shift (-180..360)</span>
              <input name="hueShift" type="number" value="0" min="-180" max="360">
            </label>
            <label class="cb-fld">
              <span>Клиент</span>
              <input name="client" placeholder="Пятёрочка">
            </label>
            <label class="cb-fld">
              <span>Год</span>
              <input name="year" placeholder="2025">
            </label>
            <label class="cb-fld">
              <span>Формат <em>(через запятую)</em></span>
              <input name="format" placeholder="CG-анимация, Рекламный ролик">
            </label>
            <label class="cb-fld">
              <span>Теги <em>(через запятую)</em></span>
              <input name="tags" placeholder="CG, ANIMATION, FAMILY">
            </label>
          </div>
          <label class="cb-fld cb-fld-block">
            <span>Lead <em>(короткий вводный абзац)</em></span>
            <textarea name="lead" rows="3"></textarea>
          </label>
          <label class="cb-fld cb-fld-block">
            <span>Описание <em>(параграфы — через пустую строку)</em></span>
            <textarea name="description" rows="8"></textarea>
          </label>
          <fieldset class="cb-fs">
            <legend>Стат-плитки</legend>
            <div class="cb-stats"></div>
            <button type="button" class="cb-mini cb-add-stat">+ Стат</button>
          </fieldset>
          <fieldset class="cb-fs">
            <legend>Команда</legend>
            <div class="cb-team"></div>
            <button type="button" class="cb-mini cb-add-team">+ Группа</button>
          </fieldset>
          <input type="hidden" name="editingId">
          <footer class="cb-foot">
            <button type="button" class="cb-mini cb-cancel" data-cb-close>Отмена</button>
            <button type="submit" class="cb-primary cb-save">Сохранить кейс</button>
          </footer>
        </form>
      </div>`;
    document.body.appendChild(m);
  }

  function cbSwitchTab(name) {
    document.querySelectorAll(".cb-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    const list = document.querySelector(".cb-view-list");
    const form = document.querySelector(".cb-view-form");
    if (list) list.hidden = name !== "list";
    if (form) form.hidden = name !== "form";
  }

  function cbRenderList() {
    const root = document.querySelector(".cb-list");
    if (!root) return;
    const custom = (content && content.customCases) || {};
    const ids = Object.keys(custom);
    if (!ids.length) {
      root.innerHTML = `<p class="cb-empty">Пока ни одного кастомного кейса. Жми «+ Новый кейс».</p>`;
      return;
    }
    root.innerHTML = ids.map(id => {
      const cc = custom[id] || {};
      return `
        <div class="cb-item" data-id="${escapeHtml(id)}">
          <div class="cb-item-meta">
            <div class="cb-item-title">${escapeHtml(cc.title || id)}</div>
            <div class="cb-item-sub">${escapeHtml(cc.brand || "—")} · ${escapeHtml(cc.eyebrow || "—")}</div>
          </div>
          <div class="cb-item-actions">
            <button type="button" class="cb-mini" data-cb-edit="${escapeHtml(id)}">Править</button>
            <button type="button" class="cb-mini cb-danger" data-cb-delete="${escapeHtml(id)}">Удалить</button>
          </div>
        </div>`;
    }).join("");
  }

  function cbClearForm() {
    const form = document.querySelector(".cb-view-form");
    if (!form) return;
    form.reset();
    form.editingId.value = "";
    form.id.readOnly = false;
    form.hueShift.value = "0";
    form.category.value = "video";
    const statsRoot = document.querySelector(".cb-stats");
    const teamRoot = document.querySelector(".cb-team");
    if (statsRoot) statsRoot.innerHTML = "";
    if (teamRoot) teamRoot.innerHTML = "";
    cbAddStat();
    cbAddTeam();
  }

  function cbFillForm(id) {
    const custom = (content && content.customCases) || {};
    const cc = custom[id] || {};
    const d = cc.details || {};
    const form = document.querySelector(".cb-view-form");
    if (!form) return;
    cbClearForm();
    form.id.value = id;
    form.id.readOnly = true;
    form.brand.value = cc.brand || "";
    form.title.value = cc.title || "";
    form.eyebrow.value = cc.eyebrow || "";
    form.category.value = cc.category || "video";
    form.hueShift.value = typeof cc.hueShift === "number" ? cc.hueShift : 0;
    form.client.value = d.client || "";
    form.year.value = d.year || "";
    form.format.value = (d.format || []).join(", ");
    form.tags.value = (d.tags || []).join(", ");
    form.lead.value = d.lead || "";
    form.description.value = (d.description || []).join("\n\n");
    form.editingId.value = id;
    const statsRoot = document.querySelector(".cb-stats");
    const teamRoot = document.querySelector(".cb-team");
    if (statsRoot) statsRoot.innerHTML = "";
    if (teamRoot) teamRoot.innerHTML = "";
    (d.stats && d.stats.length ? d.stats : [{}]).forEach(s => cbAddStat(s.n || "", s.l || ""));
    (d.team && d.team.length ? d.team : [{}]).forEach(t => cbAddTeam(t.group || "", (t.lines || []).join("\n")));
  }

  function cbAddStat(n = "", l = "") {
    const root = document.querySelector(".cb-stats");
    if (!root) return;
    const row = document.createElement("div");
    row.className = "cb-row cb-row-stat";
    row.innerHTML = `
      <input data-stat="n" value="${escapeHtml(n)}" placeholder="2">
      <input data-stat="l" value="${escapeHtml(l)}" placeholder="суток на ролик">
      <button type="button" class="cb-mini cb-row-del" aria-label="Удалить">×</button>`;
    root.appendChild(row);
  }
  function cbAddTeam(group = "", lines = "") {
    const root = document.querySelector(".cb-team");
    if (!root) return;
    const row = document.createElement("div");
    row.className = "cb-row cb-row-team";
    row.innerHTML = `
      <input data-team="group" value="${escapeHtml(group)}" placeholder="ADEPT">
      <textarea data-team="lines" rows="3" placeholder="Креативный директор — Илья К.&#10;AI-генерации — Алексей О.">${escapeHtml(lines)}</textarea>
      <button type="button" class="cb-mini cb-row-del" aria-label="Удалить">×</button>`;
    root.appendChild(row);
  }

  function openBuilder() {
    if (!password) return;
    injectCaseBuilderUI();
    const m = document.getElementById("case-builder");
    if (!m) return;
    m.hidden = false;
    document.body.classList.add("cb-open");
    cbClearForm();
    cbSwitchTab("list");
    cbRenderList();
  }
  function closeBuilder() {
    const m = document.getElementById("case-builder");
    if (!m) return;
    m.hidden = true;
    document.body.classList.remove("cb-open");
  }

  async function cbSaveCaseFromForm(form) {
    if (!password) return;
    const idRaw = (form.id.value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!idRaw) { alert("Укажи ID (латиница / цифры / дефис)"); return; }
    const stats = Array.from(form.querySelectorAll(".cb-row-stat")).map(r => ({
      n: r.querySelector('[data-stat="n"]').value.trim(),
      l: r.querySelector('[data-stat="l"]').value.trim(),
    })).filter(s => s.n || s.l);
    const team = Array.from(form.querySelectorAll(".cb-row-team")).map(r => ({
      group: r.querySelector('[data-team="group"]').value.trim(),
      lines: r.querySelector('[data-team="lines"]').value.split(/\n+/).map(l => l.trim()).filter(Boolean),
    })).filter(t => t.group || t.lines.length);
    const cc = {
      eyebrow: form.eyebrow.value.trim(),
      title: form.title.value.trim(),
      brand: form.brand.value.trim(),
      category: form.category.value || "video",
      hueShift: parseInt(form.hueShift.value, 10) || 0,
      details: {
        client: form.client.value.trim() || form.brand.value.trim(),
        year: form.year.value.trim() || "2025",
        format: form.format.value.split(",").map(s => s.trim()).filter(Boolean),
        tags: form.tags.value.split(",").map(s => s.trim()).filter(Boolean),
        lead: form.lead.value.trim(),
        description: form.description.value.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean),
        stats: stats,
        gallery: [{ img: "" }, { img: "" }, { img: "" }],
        team: team,
      },
    };
    if (!content.customCases) content.customCases = {};
    const wasNew = !content.customCases[idRaw];
    content.customCases[idRaw] = Object.assign(content.customCases[idRaw] || {}, cc);
    if (wasNew) {
      if (!content.ui) content.ui = {};
      if (!Array.isArray(content.ui.order)) content.ui.order = [];
      if (!content.ui.order.includes(idRaw)) content.ui.order.push(idRaw);
    }
    const ok = await saveContent();
    if (!ok) return;
    cbRenderList();
    cbSwitchTab("list");
    if (typeof window.adeptRenderCases === "function") window.adeptRenderCases();
    // case.html listens to this event to fully re-render
    window.dispatchEvent(new Event("adept-content-loaded"));
  }

  async function cbDeleteCase(id) {
    if (!confirm(`Удалить кейс «${id}»? Уберём его из content.json (картинки в /uploads останутся).`)) return;
    if (content.customCases) delete content.customCases[id];
    if (content.cases) delete content.cases[id];
    if (content.details) delete content.details[id];
    if (content.ui && Array.isArray(content.ui.order)) {
      content.ui.order = content.ui.order.filter(x => x !== id);
    }
    await saveContent();
    cbRenderList();
    if (typeof window.adeptRenderCases === "function") window.adeptRenderCases();
    window.dispatchEvent(new Event("adept-content-loaded"));
  }

  async function refreshVimeoThumbs() {
    if (!password) return;
    if (!confirm("Перекачать первые кадры из Vimeo для всех роликов? Это удалит кеш на сервере и заново подтянет постеры (может занять 5–15 секунд).")) return;
    showSaving(true);
    try {
      const r = await fetch("/api/refresh-thumbs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!r.ok) {
        if (r.status === 401) { password = ""; sessionStorage.removeItem("adept-auth"); }
        showSaving(false);
        alert("Не удалось обновить превью");
        return;
      }
      const j = await r.json();
      showSaving(false, `обновлено: ${j.refreshed || 0}`);
      // Pull fresh content + force re-render of pic backgrounds
      await fetchContent();
      // Bust the browser-side image cache so the new jpg shows up immediately
      document.querySelectorAll("[data-edit-img]").forEach(el => {
        if (el.style.backgroundImage && el.style.backgroundImage.includes("/uploads/vimeo-")) {
          const bust = "?t=" + Date.now();
          el.style.backgroundImage = el.style.backgroundImage.replace(/'\)/, bust + "')");
        }
      });
      if (typeof window.adeptRenderCases === "function") window.adeptRenderCases();
    } catch (e) {
      console.error(e);
      showSaving(false);
      alert("Сеть отвалилась — попробуй ещё раз");
    }
  }

  // ---- inline tag editor (case detail pages) ----
  async function editCaseTags(caseId) {
    if (!password) return;
    const cur = (
      getPath(content, `details.${caseId}.tags`) ||
      getPath(content, `customCases.${caseId}.details.tags`) ||
      []
    ).filter(t => t != null && t !== "");
    const raw = prompt(
      "Теги через запятую (например: AI VIDEO, BRAND, TENDER).\nПусто = убрать все теги.",
      cur.join(", ")
    );
    if (raw === null) return; // cancelled
    const tags = raw.split(",").map(s => s.trim()).filter(Boolean);
    // Write to both possible homes so it works for hardcoded AND custom cases
    if (getPath(content, `customCases.${caseId}`)) {
      setPath(content, `customCases.${caseId}.details.tags`, tags);
    }
    setPath(content, `details.${caseId}.tags`, tags);
    const ok = await saveContent();
    if (!ok) return;
    window.dispatchEvent(new Event("adept-content-loaded"));
  }

  // Wire builder events (delegated)
  document.addEventListener("click", async e => {
    if (e.target.closest("#edit-add-case")) { e.preventDefault(); openBuilder(); return; }
    if (e.target.closest("#edit-refresh-thumbs")) { e.preventDefault(); await refreshVimeoThumbs(); return; }
    const tagsBtn = e.target.closest(".cd-tags-edit[data-edit-tags]");
    if (tagsBtn) { e.preventDefault(); await editCaseTags(tagsBtn.dataset.editTags); return; }
    if (e.target.closest("[data-cb-close]")) { e.preventDefault(); closeBuilder(); return; }
    const tab = e.target.closest(".cb-tab");
    if (tab) { e.preventDefault(); cbSwitchTab(tab.dataset.tab); return; }
    if (e.target.closest(".cb-add-stat")) { e.preventDefault(); cbAddStat(); return; }
    if (e.target.closest(".cb-add-team")) { e.preventDefault(); cbAddTeam(); return; }
    const delBtn = e.target.closest(".cb-row-del");
    if (delBtn) { e.preventDefault(); delBtn.closest(".cb-row").remove(); return; }
    const editBtn = e.target.closest("[data-cb-edit]");
    if (editBtn) { e.preventDefault(); cbFillForm(editBtn.dataset.cbEdit); cbSwitchTab("form"); return; }
    const delCaseBtn = e.target.closest("[data-cb-delete]");
    if (delCaseBtn) { e.preventDefault(); await cbDeleteCase(delCaseBtn.dataset.cbDelete); return; }
  });
  document.addEventListener("submit", e => {
    const form = e.target.closest(".cb-view-form");
    if (!form) return;
    e.preventDefault();
    cbSaveCaseFromForm(form);
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && document.body.classList.contains("cb-open")) {
      const tgt = e.target;
      // don't close while user is editing a field — only when focus is outside
      if (tgt && (tgt.matches("input,textarea,select"))) return;
      closeBuilder();
    }
  });

  // ---- public API for dynamic pages (case.html re-renders on hashchange) ----
  window.AdeptEdit = {
    apply: applyOverrides,
    content: () => content,
    refetch: fetchContent,
    openCaseBuilder: openBuilder,
  };

  // ---- bootstrap ----
  function bootstrap() {
    // Inject the case-builder button + modal markup so they're available
    // the moment edit mode is toggled on (the bar itself is hidden until
    // body.edit-mode, but the button needs to live inside it).
    injectCaseBuilderUI();
    fetchContent();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
