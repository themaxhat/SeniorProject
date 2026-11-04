/* =====================================================================
   AI Counselor — interface behaviour (no chat or recording logic here)
   ---------------------------------------------------------------------
   1. Small helpers                 4. Background (colour or your own image)
   2. Greeting                      5. Microphone lock
   3. Chat panel: drag, minimize    6. Profile button (placeholder)
   Every section only runs if its elements exist on the page, so the same
   file is used by homepage.html and index.html.
   Loaded BEFORE script.js, which uses window.CounselorUI.
   ===================================================================== */

(function () {
  "use strict";

  /* ---------- 1. Small helpers ---------- */

  const $ = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // localStorage holds small UI preferences only (never chats or recordings).
  // It can throw in private windows, so every use is guarded.
  const prefs = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  // Show a short message in the status line (defined in script.js on the main page)
  function flash(message, ms = 5000) {
    if (typeof window.setStatus !== "function") return;
    window.setStatus(message);
    const el = $("status");
    setTimeout(() => { if (el && el.textContent === message) window.setStatus(""); }, ms);
  }


  /* ---------- 2. Greeting ---------- */

  function initGreeting() {
    const heading = $("greeting");
    const holder = document.querySelector("[data-user-name]");
    if (!heading) return;
    const name = (holder && holder.dataset.userName) || "";

    const paint = () => {
      const h = new Date().getHours();
      const part = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
      heading.textContent = name ? `${part} ${name}` : part;
    };
    paint();
    // Refresh when the tab becomes visible again (e.g. left open since the morning)
    document.addEventListener("visibilitychange", () => { if (!document.hidden) paint(); });
  }


  /* ---------- 3. Chat panel: drag to resize, minimize, reopen ---------- */

  const MIN_FRAC = 0.15;      // dragging narrower than this minimizes the chat
  const MAX_FRAC = 0.6;
  const DEFAULT_FRAC = 0.3;
  const mobileQuery = window.matchMedia("(max-width: 860px)");

  let chat = null;            // set by initChatPanel

  function initChatPanel() {
    const app = $("app"), panel = $("chat-panel"), resizer = $("resizer");
    const toggle = $("chat-toggle"), collapseBtn = $("chat-collapse"), scrim = $("chat-scrim");
    const message = $("message");
    if (!app || !panel || !resizer || !toggle) return;

    let frac = clamp(parseFloat(prefs.get("counselor.chatFrac")) || DEFAULT_FRAC, MIN_FRAC, MAX_FRAC);
    let collapsed = mobileQuery.matches ? true : prefs.get("counselor.chatCollapsed") === "1";
    let dragging = false;
    let dragFrac = frac;

    function apply() {
      app.style.setProperty("--chat-frac", frac);
      app.classList.toggle("chat-collapsed", collapsed);
      panel.inert = collapsed;                       // hidden panel can't be tabbed into
      panel.setAttribute("aria-hidden", String(collapsed));
      resizer.hidden = collapsed;
      resizer.setAttribute("aria-valuenow", Math.round(frac * 100));
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }

    function setCollapsed(value, { focus } = {}) {
      if (value === collapsed) return;
      if (value) document.dispatchEvent(new CustomEvent("counselor:chat-collapsing"));
      collapsed = value;
      if (!mobileQuery.matches) prefs.set("counselor.chatCollapsed", value ? "1" : "0");
      apply();
      if (focus === "toggle") toggle.focus();
      if (focus === "input" && message) message.focus();
    }

    function setFrac(value) {
      frac = clamp(value, MIN_FRAC, MAX_FRAC);
      prefs.set("counselor.chatFrac", String(frac));
      apply();
    }

    // --- mouse / touch / pen dragging on the divider ---
    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      dragFrac = frac;
      resizer.setPointerCapture(e.pointerId);
      app.classList.add("resizing");
      e.preventDefault();
    });

    resizer.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dragFrac = clamp(e.clientX / window.innerWidth, 0, MAX_FRAC);
      app.style.setProperty("--chat-frac", dragFrac);
      app.classList.toggle("will-collapse", dragFrac < MIN_FRAC);   // visual hint: release to minimize
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      app.classList.remove("resizing", "will-collapse");
      if (dragFrac < MIN_FRAC) setCollapsed(true, { focus: "toggle" });
      else setFrac(dragFrac);
      apply();
    }
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);

    // --- keyboard: Left/Right resize, Home/End jump, Left at the minimum minimizes ---
    resizer.addEventListener("keydown", (e) => {
      const step = 0.02;
      if (e.key === "ArrowRight") { setFrac(frac + step); }
      else if (e.key === "ArrowLeft") {
        if (frac - step < MIN_FRAC) setCollapsed(true, { focus: "toggle" });
        else setFrac(frac - step);
      }
      else if (e.key === "Home") { setFrac(MIN_FRAC); }
      else if (e.key === "End") { setFrac(MAX_FRAC); }
      else return;
      e.preventDefault();
    });

    toggle.addEventListener("click", () => setCollapsed(false, { focus: "input" }));
    if (collapseBtn) collapseBtn.addEventListener("click", () => setCollapsed(true, { focus: "toggle" }));
    if (scrim) scrim.addEventListener("click", () => setCollapsed(true, { focus: "toggle" }));

    // On phones the panel is a slide-over, so Escape closes it
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mobileQuery.matches && !collapsed && !document.querySelector(".drawer.open")) {
        setCollapsed(true, { focus: "toggle" });
      }
    });

    // Crossing the phone/desktop breakpoint: phones start minimized, desktop restores the saved state
    mobileQuery.addEventListener("change", () => {
      collapsed = mobileQuery.matches ? true : prefs.get("counselor.chatCollapsed") === "1";
      apply();
    });

    apply();
    chat = {
      open() { setCollapsed(false); },
      close() { setCollapsed(true); },
    };
  }


  /* ---------- 4. Background (colour or your own image) ----------
     Colour:  localStorage  "counselor.bgColor"
     Image:   its own small IndexedDB "ui-prefs" (the chat database is not touched)
     Mode:    localStorage  "counselor.bgMode"  ("color" | "image")                */

  const DEFAULT_BG = "#d9d9d9";
  const PRESETS = [
    ["#d9d9d9", "Soft grey (default)"],
    ["#ffffff", "White"],
    ["#efe6dc", "Warm sand"],
    ["#dce8e1", "Sage"],
    ["#dbe5f1", "Calm blue"],
    ["#2b2d33", "Charcoal"],
  ];
  const MAX_IMAGE_SIDE = 2000;        // uploads are shrunk to this many pixels on the long side
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

  // --- tiny key/value store for the uploaded image ---
  function openPrefsDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("ui-prefs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kv(mode, fn) {
    const db = await openPrefsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const request = fn(tx.objectStore("kv"));
      tx.oncomplete = () => { db.close(); resolve(request && request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  const kvGet = (key) => kv("readonly", (s) => s.get(key));
  const kvSet = (key, value) => kv("readwrite", (s) => s.put(value, key));
  const kvDelete = (key) => kv("readwrite", (s) => s.delete(key));

  // --- applying a background ---
  function luminance(r, g, b) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  let imageUrl = null;
  function releaseImage() {
    if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
  }

  // Text colour follows the background: data-bg="light" gives dark text, "dark" gives light text
  function setTone(stage, lum) {
    stage.dataset.bg = lum > 0.4 ? "light" : "dark";
  }

  function applyColor(stage, hex) {
    releaseImage();
    stage.classList.remove("has-image");
    stage.style.removeProperty("--stage-image");
    stage.style.setProperty("--stage-bg", hex);
    setTone(stage, luminance(...hexToRgb(hex)));
  }

  function averageLuminance(img) {
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += luminance(data[i], data[i + 1], data[i + 2]);
    return sum / (data.length / 4);
  }

  function applyImage(stage, blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        releaseImage();
        imageUrl = url;
        stage.style.setProperty("--stage-image", `url("${url}")`);
        stage.classList.add("has-image");
        setTone(stage, averageLuminance(img));
        resolve();
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
      img.src = url;
    });
  }

  // Shrink big photos so they stay light to store and quick to draw
  async function downscale(file) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
        img.src = url;
      });
    }
    const w = source.width, h = source.height;
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";                       // transparent PNGs get a white backing
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process that image."))), "image/jpeg", 0.88));
  }

  // Runs on every page: restores the saved background
  async function restoreBackground() {
    const stage = $("stage");
    if (!stage) return;
    const color = prefs.get("counselor.bgColor") || DEFAULT_BG;
    applyColor(stage, color);                     // instant, avoids a flash of the wrong colour
    if (prefs.get("counselor.bgMode") === "image") {
      try {
        const blob = await kvGet("background");
        if (blob) await applyImage(stage, blob);
      } catch (err) {
        console.warn("Could not restore background image:", err);
      }
    }
  }

  // Runs only where the pencil button exists
  function initBackgroundPicker() {
    const stage = $("stage"), btn = $("bg-btn"), panel = $("bg-panel");
    const swatchBox = $("bg-swatches"), colorInput = $("bg-color");
    const upload = $("bg-upload"), reset = $("bg-reset"), file = $("bg-file"), note = $("bg-note");
    if (!stage || !btn || !panel) return;

    const DEFAULT_NOTE = "Your background is saved on this device only.";
    const say = (msg) => { note.textContent = msg; };

    const swatches = PRESETS.map(([hex, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.setProperty("--c", hex);
      b.dataset.color = hex;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => chooseColor(hex));
      swatchBox.append(b);
      return b;
    });

    function markSelected() {
      const useImage = stage.classList.contains("has-image");
      const color = (prefs.get("counselor.bgColor") || DEFAULT_BG).toLowerCase();
      swatches.forEach((b) => b.setAttribute("aria-pressed", String(!useImage && b.dataset.color === color)));
      colorInput.value = /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_BG;
    }

    function chooseColor(hex) {
      applyColor(stage, hex);
      prefs.set("counselor.bgColor", hex);
      prefs.set("counselor.bgMode", "color");
      say(DEFAULT_NOTE);
      markSelected();
    }

    colorInput.addEventListener("input", () => chooseColor(colorInput.value));

    upload.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const picked = file.files && file.files[0];
      file.value = "";                            // lets the same file be chosen again later
      if (!picked) return;
      if (!picked.type.startsWith("image/")) return say("Choose an image file (PNG, JPG, WebP or GIF).");
      if (picked.size > MAX_UPLOAD_BYTES) return say("That image is over 25 MB. Choose a smaller one.");
      say("Preparing your image…");
      try {
        const small = await downscale(picked);
        await applyImage(stage, small);
        await kvSet("background", small);
        prefs.set("counselor.bgMode", "image");
        say("Background updated.");
        markSelected();
      } catch (err) {
        console.warn("Background upload failed:", err);
        say(err && err.message ? err.message : "Couldn’t use that image. Try a different one.");
      }
    });

    reset.addEventListener("click", async () => {
      try { await kvDelete("background"); } catch { /* nothing stored */ }
      chooseColor(DEFAULT_BG);
      say("Background reset.");
    });

    // --- open / close the popover ---
    function setOpen(open, { returnFocus } = {}) {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) { markSelected(); (swatches.find((b) => b.getAttribute("aria-pressed") === "true") || swatches[0]).focus(); }
      else if (returnFocus) btn.focus();
    }
    btn.addEventListener("click", () => setOpen(panel.hidden));
    document.addEventListener("pointerdown", (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) setOpen(false, { returnFocus: true });
    });

    markSelected();
  }


  /* ---------- 5. Microphone lock ----------
     Browsers do not let a web page revoke its own microphone permission, so
     this switch works inside the app: when it is OFF the app never asks the
     browser for the microphone, and any recording in progress is stopped and
     released. To remove the permission itself, use the browser's site settings. */

  let micLocked = false;

  function initMicLock() {
    const btn = $("mic-lock");
    if (!btn) return;
    micLocked = prefs.get("counselor.micLocked") === "1";

    function paint() {
      btn.setAttribute("aria-checked", String(!micLocked));
      btn.classList.toggle("is-off", micLocked);
      btn.title = micLocked
        ? "Microphone is off in this app. Select to turn it on."
        : "Microphone is on. Select to turn it off for this app.";
      document.body.dataset.micLocked = String(micLocked);
    }

    btn.addEventListener("click", () => {
      micLocked = !micLocked;
      prefs.set("counselor.micLocked", micLocked ? "1" : "0");
      paint();
      document.dispatchEvent(new CustomEvent("counselor:mic-lock-changed", { detail: { locked: micLocked } }));
      flash(micLocked
        ? "Microphone off in this app. To also remove the browser’s permission, use your browser’s site settings."
        : "Microphone on. Your browser may ask for permission the first time you record.", 7000);
    });

    paint();
  }

  // Draws attention to the lock button when the orb is used while the mic is off
  function flashMicLock() {
    const btn = $("mic-lock");
    if (!btn) return;
    btn.classList.remove("nudge");
    void btn.offsetWidth;                           // restart the CSS animation
    btn.classList.add("nudge");
    btn.focus();
  }


  /* ---------- 6. Profile button (placeholder) ---------- */

  function initProfile() {
    const btn = $("profile-btn");
    if (!btn) return;
    btn.addEventListener("click", () => flash("Account and settings are coming soon.", 3000));
  }


  /* ---------- Start ---------- */

  initGreeting();
  initChatPanel();
  restoreBackground();
  initBackgroundPicker();
  initMicLock();
  initProfile();

  // Used by script.js
  window.CounselorUI = {
    isMicLocked: () => micLocked,
    flashMicLock,
    openChat: () => chat && chat.open(),
    closeChat: () => chat && chat.close(),
  };
})();
