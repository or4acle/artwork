(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Settings — safe to edit
   * ------------------------------------------------------------------ */
  const CONFIG = {
    WARNING_DAYS: 7,        // remember the content notice for N days; 0 = ask again every browser session
    PAGE_SIZE: 90,          // tiles drawn per batch while scrolling
    SLIDESHOW_MS: 4000,     // time each photo stays on screen in slideshow mode (milliseconds)
    MAX_ZOOM: 6,
  };
  const KEYS = {
    favs: "or4acle-gallery:favourites",
    oldFavs: "simple-gallery-favourites",   // migrated automatically
    warning: "or4acle-gallery:warning",
    prefs: "or4acle-gallery:prefs",
  };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  const store = {
    get(key, area = localStorage) { try { return area.getItem(key); } catch { return null; } },
    set(key, value, area = localStorage) { try { area.setItem(key, value); } catch { /* storage unavailable */ } },
  };

  const els = {
    gallery: $("#gallery"), sentinel: $("#sentinel"), search: $("#search"), count: $("#count"),
    empty: $("#empty"), loading: $("#loading"), types: $("#types"), albums: $("#albums"),
    sort: $("#sort"), title: $("#page-title"), subtitle: $("#page-subtitle"),
    favTools: $("#fav-tools"), favNavCount: $("#fav-nav-count"), toast: $("#toast"),
    viewer: $("#viewer"), content: $("#viewer-content"), caption: $("#caption"),
    viewerFav: $("#viewer-fav"), download: $("#viewer-download"), slideshowBtn: $("#slideshow"),
    zoomReset: $("#zoom-reset"), warning: $("#content-warning"),
  };

  const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"];
  const VIDEO_EXT = ["mp4", "webm", "ogv", "m4v"];
  const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
  const extOf = (path) => path.split(".").pop().toLowerCase();
  const kindOf = (path) => {
    const ext = extOf(path);
    if (IMAGE_EXT.includes(ext)) return "image";
    if (VIDEO_EXT.includes(ext)) return "video";
    if (AUDIO_EXT.includes(ext)) return "audio";
    return null;
  };
  const albumOf = (path) => { const parts = path.split("/"); return parts.length > 2 ? parts[1] : "Unsorted"; };
  const safeURL = (path) => path.split("/").map(encodeURIComponent).join("/");
  const prettyName = (name) => name.replace(/\.[^.]+$/, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim() || name;
  const formatSize = (bytes) => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  };
  const formatDuration = (seconds) => {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const hashString = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2400);
  }

  /* ------------------------------------------------------------------ *
   * Content notice (kept from the original site)
   * Nothing is requested from the server until the visitor accepts.
   * ------------------------------------------------------------------ */
  function warningAccepted() {
    if (CONFIG.WARNING_DAYS <= 0) return store.get(KEYS.warning, sessionStorage) === "yes";
    const saved = Number(store.get(KEYS.warning));
    return Boolean(saved) && Date.now() - saved < CONFIG.WARNING_DAYS * 864e5;
  }
  function askWarning() {
    return new Promise((resolve) => {
      if (warningAccepted()) return resolve();
      els.warning.addEventListener("cancel", (event) => event.preventDefault()); // Esc must not skip it
      $("#warning-leave").addEventListener("click", () => window.location.replace("about:blank"));
      $("#warning-continue").addEventListener("click", () => {
        if (CONFIG.WARNING_DAYS <= 0) store.set(KEYS.warning, "yes", sessionStorage);
        else store.set(KEYS.warning, String(Date.now()));
        els.warning.close();
        resolve();
      }, { once: true });
      els.warning.showModal();
    });
  }

  /* ------------------------------------------------------------------ *
   * Favourites (stored in this browser; export/import for backups)
   * ------------------------------------------------------------------ */
  const favs = (() => {
    try {
      const raw = store.get(KEYS.favs) ?? store.get(KEYS.oldFavs);
      const list = JSON.parse(raw || "[]");
      return new Set(Array.isArray(list) ? list.filter((p) => typeof p === "string") : []);
    } catch { return new Set(); }
  })();
  const saveFavs = () => store.set(KEYS.favs, JSON.stringify([...favs]));

  /* ------------------------------------------------------------------ *
   * Data
   * ------------------------------------------------------------------ */
  let loaded = false;
  let allItems = [];
  let pathSet = new Set();
  let visible = [];
  let rendered = 0;
  const prefs = (() => { try { return { layout: "rows", ...JSON.parse(store.get(KEYS.prefs) || "{}") }; } catch { return { layout: "rows" }; } })();

  function normalize(entry) {
    const o = typeof entry === "string" ? { path: entry } : entry;
    if (!o || typeof o.path !== "string") return null;
    const kind = o.kind || kindOf(o.path);
    if (!kind) return null;
    const name = o.name || o.path.split("/").pop();
    return {
      path: o.path, kind, name, title: prettyName(name), ext: extOf(o.path),
      album: o.album || albumOf(o.path),
      size: o.size || 0, mtime: o.mtime || 0, w: o.w || 0, h: o.h || 0, dur: o.dur || 0,
      thumb: o.thumb || null, rand: 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * State  <->  URL hash   (#/favs?album=Trips&type=video&sort=new&q=sun&item=media/a.jpg)
   * ------------------------------------------------------------------ */
  const SORTS = {
    name: (a, b) => collator.compare(a.name, b.name),
    "name-desc": (a, b) => collator.compare(b.name, a.name),
    new: (a, b) => b.mtime - a.mtime || collator.compare(a.name, b.name),
    old: (a, b) => a.mtime - b.mtime || collator.compare(a.name, b.name),
    random: (a, b) => a.rand - b.rand,
  };
  const TYPES = ["all", "image", "video", "audio"];
  const DEFAULT_STATE = { view: "all", album: "All", type: "all", sort: "name", q: "", item: "" };
  let state = { ...DEFAULT_STATE };
  let lastHash = location.hash;
  let shuffleSeed = Math.random();

  function parseHash() {
    const [route, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
    const params = new URLSearchParams(query);
    const next = { ...DEFAULT_STATE, view: route === "favs" ? "favs" : "all" };
    if (params.get("album")) next.album = params.get("album");
    if (TYPES.includes(params.get("type"))) next.type = params.get("type");
    if (SORTS[params.get("sort")]) next.sort = params.get("sort");
    if (params.get("q")) next.q = params.get("q");
    if (params.get("item")) next.item = params.get("item");
    return next;
  }
  function buildHash(s) {
    const params = new URLSearchParams();
    if (s.album !== "All") params.set("album", s.album);
    if (s.type !== "all") params.set("type", s.type);
    if (s.sort !== "name") params.set("sort", s.sort);
    if (s.q) params.set("q", s.q);
    if (s.item) params.set("item", s.item);
    const query = params.toString();
    return `#/${s.view === "favs" ? "favs" : ""}${query ? `?${query}` : ""}`;
  }
  function writeState(mode = "replace") {
    const hash = buildHash(state);
    const current = location.hash || "#/";
    if (hash === current) return;
    history[mode === "push" ? "pushState" : "replaceState"](null, "", hash);
    lastHash = location.hash;
  }

  /* ------------------------------------------------------------------ *
   * Filtering, sorting, rendering
   * ------------------------------------------------------------------ */
  const baseItems = () => allItems.filter((item) => state.view !== "favs" || favs.has(item.path));
  const matchesType = (item) => state.type === "all" || item.kind === state.type;
  const matchesTerm = (item) => {
    const term = state.q.trim().toLocaleLowerCase();
    return !term || `${item.name} ${item.album}`.toLocaleLowerCase().includes(term);
  };
  const favCount = () => { let n = 0; for (const p of favs) if (pathSet.has(p)) n++; return n; };

  function computeVisible() {
    const base = baseItems();
    if (state.album !== "All" && !base.some((item) => item.album === state.album)) {
      state.album = "All";
      writeState("replace");
    }
    if (state.sort === "random") for (const item of allItems) item.rand = hashString(item.path + shuffleSeed);
    visible = base
      .filter((item) => matchesType(item) && matchesTerm(item) && (state.album === "All" || item.album === state.album))
      .sort(SORTS[state.sort]);
  }

  function syncControls() {
    const isFavs = state.view === "favs";
    document.body.dataset.page = state.view;
    for (const link of $$(".nav-link")) {
      const active = link.dataset.view === state.view;
      link.classList.toggle("active", active);
      active ? link.setAttribute("aria-current", "page") : link.removeAttribute("aria-current");
    }
    if (els.search.value !== state.q) els.search.value = state.q;
    els.sort.value = state.sort;
    const kinds = new Set(allItems.map((item) => item.kind));
    els.types.hidden = kinds.size < 2;
    for (const chip of $$("#types .chip")) {
      const on = chip.dataset.type === state.type;
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.hidden = chip.dataset.type !== "all" && !kinds.has(chip.dataset.type);
    }
    for (const button of $$(".segmented button")) {
      const on = button.dataset.layout === prefs.layout;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    }
    els.gallery.dataset.layout = prefs.layout;
    els.favTools.hidden = !isFavs;
    const heading = isFavs ? "Favourites" : state.album !== "All" ? state.album : "All media";
    els.title.textContent = heading;
    els.subtitle.textContent = isFavs
      ? "Saved in this browser. Use Export to keep a backup."
      : state.album !== "All" ? "Album from the personal collection by or4acle." : "A personal collection by or4acle.";
    els.empty.textContent = isFavs && !state.q && state.type === "all"
      ? "No favourites yet. Tap the heart on any item to save it here."
      : allItems.length ? "No items match your filters." : "Nothing here yet. Add files to the media/ folder and push.";
    document.title = `${heading} — or4acle`;
    updateFavCount();
  }

  function renderAlbums() {
    const pool = baseItems().filter((item) => matchesType(item) && matchesTerm(item));
    const counts = new Map();
    for (const item of pool) counts.set(item.album, (counts.get(item.album) || 0) + 1);
    if (state.album !== "All" && !counts.has(state.album)) counts.set(state.album, 0);
    const names = [...counts.keys()].sort(collator.compare);
    els.albums.hidden = names.length < 2;
    els.albums.replaceChildren();
    const make = (name, label, total) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chip${state.album === name ? " active" : ""}`;
      button.dataset.album = name;
      button.setAttribute("aria-pressed", String(state.album === name));
      button.append(label);
      const small = document.createElement("span");
      small.className = "chip-count";
      small.textContent = total;
      button.append(small);
      els.albums.append(button);
    };
    make("All", "All albums", pool.length);
    for (const name of names) make(name, name, counts.get(name));
  }

  function makeTile(item) {
    const tile = document.createElement("article");
    tile.className = `tile kind-${item.kind}`;
    tile.dataset.path = item.path;
    const ratio = item.w && item.h ? item.w / item.h : item.kind === "audio" ? 1.6 : 1;
    tile.style.setProperty("--ar", clamp(ratio, 0.4, 3).toFixed(3));

    const open = document.createElement("button");
    open.type = "button";
    open.className = "media-open";
    open.title = item.name;
    open.setAttribute("aria-label", `Open ${item.title}`);

    if (item.kind === "image" || (item.kind === "video" && item.thumb)) {
      const img = document.createElement("img");
      img.src = safeURL(item.thumb || item.path);
      img.alt = item.kind === "image" ? item.title : "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        if (item.thumb && img.dataset.fallback !== "1" && item.kind === "image") {
          img.dataset.fallback = "1";
          img.src = safeURL(item.path);
        }
      });
      open.append(img);
    } else if (item.kind === "video") {
      const video = document.createElement("video");
      video.src = `${safeURL(item.path)}#t=0.1`;
      video.muted = true; video.preload = "metadata"; video.playsInline = true;
      open.append(video);
    } else {
      const card = document.createElement("div");
      card.className = "audio-card";
      const icon = document.createElement("span");
      icon.className = "audio-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = "♫";
      const name = document.createElement("span");
      name.className = "audio-name"; name.textContent = item.title;
      card.append(icon, name);
      open.append(card);
    }

    const badgeText = item.kind === "video" ? `▶ ${formatDuration(item.dur)}`.trim()
      : item.kind === "audio" ? formatDuration(item.dur)
      : item.ext === "gif" ? "GIF" : "";
    if (badgeText) {
      const badge = document.createElement("span");
      badge.className = "badge"; badge.textContent = badgeText;
      open.append(badge);
    }
    open.addEventListener("click", () => openAt(visible.indexOf(item)));

    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "fav-toggle";
    fav.addEventListener("click", (event) => { event.stopPropagation(); toggleFavourite(item.path); });
    tile.append(open, fav);
    paintFav(fav, item.path);
    return tile;
  }

  function appendChunk() {
    if (rendered >= visible.length) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(visible.length, rendered + CONFIG.PAGE_SIZE);
    for (let i = rendered; i < end; i++) fragment.append(makeTile(visible[i]));
    rendered = end;
    els.gallery.append(fragment);
  }

  function render({ keep = false } = {}) {
    const previous = rendered;
    computeVisible();
    els.gallery.replaceChildren();
    rendered = 0;
    appendChunk();
    while (keep && rendered < previous && rendered < visible.length) appendChunk();
    els.count.textContent = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;
    els.empty.hidden = visible.length !== 0;
    observeSentinel();
  }

  let observer;
  function observeSentinel() {
    if (!("IntersectionObserver" in window)) { while (rendered < visible.length) appendChunk(); return; }
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        appendChunk();
        // if the sentinel is still on screen, check again
        observer.unobserve(els.sentinel);
        if (rendered < visible.length) observer.observe(els.sentinel);
      }, { rootMargin: "800px 0px" });
    }
    observer.unobserve(els.sentinel);
    if (rendered < visible.length) observer.observe(els.sentinel);
  }

  function refreshAll({ keep = false } = {}) {
    syncControls();
    renderAlbums();
    render({ keep });
  }

  /* ------------------------------------------------------------------ *
   * Favourites UI
   * ------------------------------------------------------------------ */
  function paintFav(button, path) {
    const on = favs.has(path);
    button.classList.toggle("is-fav", on);
    button.textContent = on ? "♥" : "♡";
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Remove from favourites" : "Add to favourites");
  }
  function updateFavCount() {
    const n = favCount();
    els.favNavCount.textContent = n ? `(${n})` : "";
  }
  function toggleFavourite(path) {
    favs.has(path) ? favs.delete(path) : favs.add(path);
    saveFavs();
    updateFavCount();
    for (const tile of $$(".tile", els.gallery)) if (tile.dataset.path === path) paintFav($(".fav-toggle", tile), path);
    if (viewerActive) paintFav(els.viewerFav, viewerList[current].path);
    // On the favourites page, items disappear right away — unless the viewer is open
    // (the grid updates when it closes, so navigation never jumps to the wrong item).
    if (state.view === "favs" && !viewerActive) { renderAlbums(); render({ keep: true }); }
  }

  /* ------------------------------------------------------------------ *
   * Viewer
   * ------------------------------------------------------------------ */
  let viewerActive = false;
  let viewerPushed = false;
  let viewerList = [];
  let current = 0;
  let zoom = 1, panX = 0, panY = 0;
  let slideshow = false;
  let slideTimer;

  const viewerImage = () => $("img", els.content);
  els.content.tabIndex = -1;

  function applyZoom() {
    const img = viewerImage();
    if (img) img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    els.zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    els.content.classList.toggle("is-zoomed", zoom > 1);
  }
  function clampPan() {
    const img = viewerImage();
    if (!img || zoom <= 1) { panX = panY = 0; return; }
    const maxX = (img.clientWidth * (zoom - 1)) / 2;
    const maxY = (img.clientHeight * (zoom - 1)) / 2;
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
  }
  function setZoom(value) { zoom = clamp(value, 1, CONFIG.MAX_ZOOM); clampPan(); applyZoom(); }
  function resetZoom() { zoom = 1; panX = panY = 0; applyZoom(); }

  function preload(item) {
    if (item && item.kind === "image") new Image().src = safeURL(item.path);
  }

  function showItem(index) {
    if (!viewerList.length) return;
    const count = viewerList.length;
    current = ((index % count) + count) % count;
    const item = viewerList[current];
    clearTimeout(slideTimer);
    els.content.replaceChildren();
    resetZoom();
    els.content.classList.add("is-loading");
    const done = () => els.content.classList.remove("is-loading");
    const failed = (media) => {
      done();
      const note = document.createElement("p");
      note.className = "viewer-error";
      note.textContent = "Could not load this file.";
      media.replaceWith(note);
      if (slideshow) slideTimer = setTimeout(() => step(1), 1500);
    };

    let media;
    if (item.kind === "image") {
      media = document.createElement("img");
      media.src = safeURL(item.path); media.alt = item.title; media.draggable = false;
      media.addEventListener("load", done);
    } else if (item.kind === "video") {
      media = document.createElement("video");
      media.src = safeURL(item.path); media.controls = true; media.playsInline = true;
      media.autoplay = true; media.muted = true;           // silent autoplay; unmute with the controls
      media.addEventListener("loadeddata", done);
    } else {
      media = document.createElement("div");
      media.className = "audio-stage";
      const icon = document.createElement("span");
      icon.className = "audio-icon"; icon.textContent = "♫"; icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = item.title;
      const audio = document.createElement("audio");
      audio.src = safeURL(item.path); audio.controls = true; audio.autoplay = slideshow;
      audio.addEventListener("loadeddata", done);
      audio.addEventListener("error", () => failed(media));
      media.append(icon, label, audio);
    }
    if (item.kind !== "audio") media.addEventListener("error", () => failed(media));
    els.content.append(media);

    const playable = item.kind === "audio" ? $("audio", media) : item.kind === "video" ? media : null;
    if (slideshow) {
      if (playable) playable.addEventListener("ended", () => slideshow && step(1), { once: true });
      else slideTimer = setTimeout(() => step(1), CONFIG.SLIDESHOW_MS);
    }

    const parts = [`${item.album} / ${item.name}`];
    if (item.w && item.h) parts.push(`${item.w}×${item.h}`);
    if (item.size) parts.push(formatSize(item.size));
    parts.push(`${current + 1} of ${count}`);
    els.caption.textContent = parts.join("  ·  ");
    paintFav(els.viewerFav, item.path);
    els.download.href = safeURL(item.path);
    els.download.setAttribute("download", item.name);

    preload(viewerList[(current + 1) % count]);
    preload(viewerList[(current - 1 + count) % count]);

    viewerActive = true;
    if (!els.viewer.open) els.viewer.showModal();
    els.content.focus({ preventScroll: true });
  }

  function openAt(index) {
    if (index < 0 || !visible.length) return;
    if (!viewerActive) viewerList = visible;
    const target = viewerList[((index % viewerList.length) + viewerList.length) % viewerList.length];
    state.item = target.path;
    const wasActive = viewerActive;
    writeState(wasActive ? "replace" : "push");
    if (!wasActive) viewerPushed = true;     // Back button will close the viewer
    showItem(viewerList.indexOf(target));
  }
  const step = (amount) => openAt(current + amount);

  function teardownViewer() {
    if (!viewerActive) return;
    viewerActive = false;
    clearTimeout(slideTimer);
    setSlideshow(false);
    els.content.replaceChildren();          // stops any playing audio/video
    if (els.viewer.open) els.viewer.close();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (state.view === "favs") { renderAlbums(); render({ keep: true }); }
  }
  function closeViewer() {
    if (!viewerActive) return;
    state.item = "";
    if (viewerPushed) { viewerPushed = false; history.back(); }
    else writeState("replace");
    teardownViewer();
  }
  function syncViewerFromState() {
    if (!state.item) { teardownViewer(); return; }
    if (viewerActive && viewerList[current]?.path === state.item) return;
    const index = visible.findIndex((item) => item.path === state.item);
    if (index < 0) { state.item = ""; writeState("replace"); teardownViewer(); return; }
    viewerList = visible;
    showItem(index);
  }

  function setSlideshow(on) {
    slideshow = on;
    els.slideshowBtn.setAttribute("aria-pressed", String(on));
    els.slideshowBtn.textContent = on ? "Pause" : "Slideshow";
    els.slideshowBtn.classList.toggle("is-on", on);
  }
  function toggleSlideshow() {
    if (viewerList.length < 2) { toast("Slideshow needs at least two items."); return; }
    setSlideshow(!slideshow);
    showItem(current);
  }

  /* Pointer gestures: wheel / pinch zoom, drag to pan, swipe to navigate, double-tap to zoom */
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;
  const pinchDistance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  els.content.addEventListener("wheel", (event) => {
    if (!event.target.closest("img")) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  els.content.addEventListener("pointerdown", (event) => {
    if (event.target.closest("video, audio")) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    els.content.setPointerCapture(event.pointerId);
    if (pointers.size === 2) gesture = { type: "pinch", dist: pinchDistance(), zoom0: zoom };
    else if (pointers.size === 1) {
      gesture = zoom > 1
        ? { type: "pan", sx: event.clientX - panX, sy: event.clientY - panY }
        : { type: "swipe", x: event.clientX, y: event.clientY, onImage: Boolean(event.target.closest("img")) };
    }
  });
  els.content.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.type === "pinch" && pointers.size === 2) setZoom(gesture.zoom0 * (pinchDistance() / gesture.dist));
    else if (gesture.type === "pan") { panX = event.clientX - gesture.sx; panY = event.clientY - gesture.sy; clampPan(); applyZoom(); }
  });
  const endPointer = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (gesture?.type === "swipe" && event.type === "pointerup") {
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      else if (Math.hypot(dx, dy) < 10 && gesture.onImage) {
        const now = Date.now();
        if (now - lastTap < 320) { zoom > 1 ? resetZoom() : setZoom(2.5); lastTap = 0; } else lastTap = now;
      }
    }
    gesture = pointers.size === 1 && zoom > 1
      ? { type: "pan", sx: [...pointers.values()][0].x - panX, sy: [...pointers.values()][0].y - panY }
      : null;
  };
  els.content.addEventListener("pointerup", endPointer);
  els.content.addEventListener("pointercancel", endPointer);

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */
  $("#close").addEventListener("click", closeViewer);
  $("#prev").addEventListener("click", () => step(-1));
  $("#next").addEventListener("click", () => step(1));
  $("#zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  $("#zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  els.zoomReset.addEventListener("click", resetZoom);
  els.slideshowBtn.addEventListener("click", toggleSlideshow);
  $("#fullscreen").addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await els.viewer.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast("Fullscreen is not available here."); }
  });
  els.viewerFav.addEventListener("click", () => { if (viewerActive) toggleFavourite(viewerList[current].path); });
  $("#viewer-link").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied."); }
    catch { toast("Could not copy. Copy the address bar instead."); }
  });
  els.viewer.addEventListener("click", (event) => { if (event.target === els.viewer) closeViewer(); });
  els.viewer.addEventListener("cancel", (event) => { event.preventDefault(); closeViewer(); });
  els.viewer.addEventListener("close", () => { if (viewerActive) closeViewer(); });

  let searchTimer;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = els.search.value.trim();
      writeState("replace");
      renderAlbums();
      render();
    }, 150);
  });
  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    if (state.sort === "random") shuffleSeed = Math.random();
    writeState("replace");
    render();
  });
  els.types.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.type = chip.dataset.type;
    writeState("replace");
    refreshAll();
  });
  els.albums.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.album = chip.dataset.album;
    writeState("replace");
    refreshAll();
  });
  for (const button of $$(".segmented button")) {
    button.addEventListener("click", () => {
      prefs.layout = button.dataset.layout;
      store.set(KEYS.prefs, JSON.stringify(prefs));
      syncControls();
    });
  }

  $("#fav-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ version: 1, favourites: [...favs] }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "or4acle-favourites.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  $("#fav-import").addEventListener("click", () => $("#fav-import-file").click());
  $("#fav-import-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.favourites;
      if (!Array.isArray(list)) throw new Error("bad format");
      let added = 0, missing = 0;
      for (const path of list) {
        if (typeof path !== "string") continue;
        if (!pathSet.has(path)) missing++;
        if (!favs.has(path)) { favs.add(path); added++; }
      }
      saveFavs();
      refreshAll();
      toast(`Imported ${added} new favourite${added === 1 ? "" : "s"}${missing ? ` (${missing} not found in this gallery)` : ""}.`);
    } catch { toast("That file is not a valid favourites export."); }
  });

  function onNavigate() {
    if (!loaded || location.hash === lastHash) return;
    lastHash = location.hash;
    const previous = state;
    state = parseHash();
    if (["view", "album", "type", "sort", "q"].some((key) => previous[key] !== state[key])) refreshAll();
    syncViewerFromState();
  }
  window.addEventListener("hashchange", onNavigate);
  window.addEventListener("popstate", onNavigate);

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (els.warning.open) return;
    if (!els.viewer.open) {
      if (event.key === "/" && document.activeElement !== els.search && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
        event.preventDefault();
        els.search.focus();
      }
      return;
    }
    switch (event.key) {
      case "ArrowLeft": step(-1); break;
      case "ArrowRight": step(1); break;
      case "+": case "=": setZoom(zoom * 1.25); break;
      case "-": setZoom(zoom / 1.25); break;
      case "0": resetZoom(); break;
      case "f": case "F": if (viewerActive) toggleFavourite(viewerList[current].path); break;
      case "s": case "S": toggleSlideshow(); break;
      case " ": {
        if (event.target.closest?.("button, a, video, audio")) return;   // keep native behaviour on focused controls
        event.preventDefault();
        const media = $("video, audio", els.content);
        if (media) media.paused ? media.play() : media.pause();
        else toggleSlideshow();
        break;
      }
      default: return;
    }
  });

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  async function start() {
    syncControls();
    await askWarning();
    try {
      const response = await fetch("./media.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const seen = new Set();
      allItems = data.map(normalize).filter((item) => item && !seen.has(item.path) && seen.add(item.path));
      pathSet = seen;
      loaded = true;
      els.loading.hidden = true;
      state = parseHash();
      lastHash = location.hash;
      refreshAll();
      syncViewerFromState();
    } catch (error) {
      els.loading.textContent = "Could not load media.json. Run generate_manifest.py (or check the GitHub Pages workflow) and reload.";
      console.error(error);
    }
  }
  start();
})();
