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

  // ---- apply overrides to current DOM ----
  function applyOverrides() {
    document.querySelectorAll("[data-edit]").forEach(el => {
      const v = getPath(content, el.dataset.edit);
      if (typeof v === "string" && el.textContent !== v) el.textContent = v;
    });
    document.querySelectorAll("[data-edit-img]").forEach(el => {
      const v = getPath(content, el.dataset.editImg + ".img");
      if (el.dataset.origBg === undefined) {
        el.dataset.origBg = el.style.backgroundImage || "";
        el.dataset.origFilter = el.style.filter || "";
      }
      if (typeof v === "string" && v) {
        el.style.backgroundImage = `url('${v}')`;
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
    } else if (action === "reset") {
      unsetPath(content, `${target}.img`);
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
