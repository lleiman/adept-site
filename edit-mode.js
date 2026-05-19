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

  // ---- apply overrides to current DOM ----
  function applyOverrides() {
    applyNavFont();
    applyBrandStyle();
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
