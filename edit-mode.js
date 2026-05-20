// ============================================================
//  ADEPT — inline edit mode (shared across pages)
//
//  Toggle with ⌘E (Mac) or Ctrl+E. On first toggle in a session
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

      if (el.dataset.origBg === undefined) {
        el.dataset.origBg = el.style.backgroundImage || "";
        el.dataset.origFilter = el.style.filter || "";
      }

      const old = el.querySelector(":scope > iframe.adept-video");

      // If video mode + vimeo set → render iframe over the slot, no poster
      // (the user explicitly wants no still-frame flash before the video)
      if (videoMode && vimeo && vimeo.id) {
        const wantedSrc = vimeoSrc(vimeo, videoMode);
        if (old && old.src === wantedSrc) {
          // Server already injected the right iframe; just clear bg image
          // so there's no flash, leave the iframe alone (no restart).
          el.style.backgroundImage = "none";
          el.style.filter = "none";
          return;
        }
        if (old) old.remove();
        const ifr = document.createElement("iframe");
        ifr.className = "adept-video";
        ifr.src = wantedSrc;
        ifr.allow = "autoplay; fullscreen; picture-in-picture; clipboard-write";
        ifr.allowFullscreen = true;
        el.appendChild(ifr);
        el.style.backgroundImage = "none";
        el.style.filter = "none";
        return;
      }

      // No video → remove any leftover iframe (e.g. after "Сбросить")
      if (old) old.remove();

      // Otherwise just image (override or default)
      if (typeof imgUrl === "string" && imgUrl) {
        el.style.backgroundImage = `url('${imgUrl}')`;
        el.style.filter = "none";
      } else {
        el.style.backgroundImage = el.dataset.origBg;
        el.style.filter = el.dataset.origFilter || "";
      }
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
  }
  function toggle() { return setMode(!body.classList.contains("edit-mode")); }

  // ---- keyboard ----
  window.addEventListener("keydown", e => {
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (cmd && (e.key === "e" || e.key === "E")) {
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

  // ---- public API for dynamic pages (case.html re-renders on hashchange) ----
  window.AdeptEdit = {
    apply: applyOverrides,
    content: () => content,
    refetch: fetchContent,
  };

  // ---- bootstrap ----
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchContent);
  } else {
    fetchContent();
  }
})();
