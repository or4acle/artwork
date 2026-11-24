(() => {
  const $ = (selector) => document.querySelector(selector);
  const gallery = $("#gallery");
  const search = $("#search");
  const count = $("#count");
  const empty = $("#empty");
  const loading = $("#loading");
  const viewer = $("#viewer");
  const viewerContent = $("#viewer-content");
  const caption = $("#caption");
  const warning = $("#content-warning");
  const WARNING_KEY = "simple-gallery-content-warning-accepted";
  if (warning && sessionStorage.getItem(WARNING_KEY) !== "yes") warning.showModal();
  $("#warning-continue")?.addEventListener("click", () => {
    sessionStorage.setItem(WARNING_KEY, "yes");
    warning.close();
  });
  $("#warning-leave")?.addEventListener("click", () => window.location.replace("about:blank"));

  const isFavPage = document.body.dataset.page === "favs";
  const FAV_KEY = "simple-gallery-favourites";

  let allItems = [];
  let visible = [];
  let current = 0;
  let activeAlbum = "All";
  let sortAscending = true;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let pointerStart = null;

  const readFavourites = () => {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
    catch { return new Set(); }
  };
  const saveFavourites = (set) => {
    localStorage.setItem(FAV_KEY, JSON.stringify([...set]));
    updateFavouriteCount();
  };
  const favourites = readFavourites();
  const isFavourite = (path) => favourites.has(path);
  const toggleFavourite = (path) => {
    if (favourites.has(path)) favourites.delete(path);
    else favourites.add(path);
    saveFavourites(favourites);
    if (isFavPage) render();
    else updateFavouriteButtons();
  };
  const updateFavouriteCount = () => {
    const node = $("#fav-nav-count");
    if (node) node.textContent = favourites.size ? `(${favourites.size})` : "";
  };
  const kindOf = (path) => {
    const ext = path.split(".").pop().toLowerCase();
    if (["jpg","jpeg","png","gif","webp","avif","bmp","svg"].includes(ext)) return "image";
    if (["mp4","webm","ogv","mov","m4v"].includes(ext)) return "video";
    if (["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return "audio";
    return null;
  };
  const albumOf = (path) => {
    const parts = path.split("/");
    return parts.length > 2 ? parts[1] : "Unsorted";
  };
  const safeURL = (path) => path.split("/").map(encodeURIComponent).join("/");

  async function start() {
    try {
      const response = await fetch("./media.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load media.json");
      const paths = await response.json();
      allItems = paths.map(path => ({ path, kind: kindOf(path), name: path.split("/").pop(), album: albumOf(path) }))
        .filter(item => item.kind);
      loading.hidden = true;
      if (!isFavPage) renderAlbums();
      render();
      updateFavouriteCount();
    } catch (error) {
      loading.textContent = "Could not load media.json. Check the GitHub Pages workflow and try again.";
      console.error(error);
    }
  }

  function renderAlbums() {
    const albums = $("#albums");
    if (!albums) return;
    albums.replaceChildren();
    const names = ["All", ...new Set(allItems.map(item => item.album).sort((a,b) => a.localeCompare(b)))];
    for (const name of names) {
      const button = document.createElement("button");
      button.className = `album${activeAlbum === name ? " active" : ""}`;
      button.textContent = name === "All" ? "All albums" : name;
      button.addEventListener("click", () => {
        activeAlbum = name;
        renderAlbums();
        render();
      });
      albums.append(button);
    }
  }

  function render() {
    const term = search.value.trim().toLocaleLowerCase("en");
    visible = allItems.filter(item =>
      (!isFavPage || isFavourite(item.path)) &&
      (isFavPage || activeAlbum === "All" || item.album === activeAlbum) &&
      `${item.name} ${item.album}`.toLocaleLowerCase("en").includes(term)
    );
    visible.sort((a,b) => a.name.localeCompare(b.name) * (sortAscending ? 1 : -1));
    gallery.replaceChildren();
    count.textContent = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;
    empty.hidden = visible.length !== 0;

    for (const [index, item] of visible.entries()) {
      const tile = document.createElement("article");
      tile.className = "tile";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "media-open";
      open.style.cssText = "display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:zoom-in;";
      open.title = item.name;
      if (item.kind === "image") {
        const img = document.createElement("img");
        img.src = safeURL(item.path); img.alt = item.name; img.loading = "lazy";
        open.append(img);
      } else if (item.kind === "video") {
        const video = document.createElement("video");
        video.src = safeURL(item.path); video.muted = true; video.preload = "metadata";
        open.append(video);
      } else {
        const card = document.createElement("div");
        card.className = "audio-card";
        card.innerHTML = '<span class="audio-icon" aria-hidden="true">♫</span>';
        const name = document.createElement("span"); name.textContent = item.name;
        const audio = document.createElement("audio");
        audio.src = safeURL(item.path); audio.controls = true;
        audio.addEventListener("click", event => event.stopPropagation());
        card.append(name, audio); open.append(card);
      }
      open.addEventListener("click", () => openAt(index));
      const fav = document.createElement("button");
      fav.type = "button";
      fav.className = `fav-toggle${isFavourite(item.path) ? " is-fav" : ""}`;
      fav.textContent = isFavourite(item.path) ? "♥" : "♡";
      fav.setAttribute("aria-label", isFavourite(item.path) ? "Remove from favourites" : "Add to favourites");
      fav.addEventListener("click", event => { event.stopPropagation(); toggleFavourite(item.path); });
      tile.append(open, fav);
      gallery.append(tile);
    }
  }

  function applyZoom() {
    const media = viewerContent.querySelector("img");
    if (media) media.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const reset = $("#zoom-reset");
    if (reset) reset.textContent = `${Math.round(zoom * 100)}%`;
  }
  function changeZoom(amount) {
    zoom = Math.min(6, Math.max(1, zoom + amount));
    if (zoom === 1) panX = panY = 0;
    applyZoom();
  }
  function resetZoom() { zoom = 1; panX = panY = 0; applyZoom(); }

  function openAt(index) {
    if (!visible.length) return;
    current = (index + visible.length) % visible.length;
    const item = visible[current];
    viewerContent.replaceChildren();
    resetZoom();
    let media;
    if (item.kind === "image") {
      media = document.createElement("img");
      media.src = safeURL(item.path); media.alt = item.name; media.draggable = false;
      media.addEventListener("wheel", event => {
        event.preventDefault();
        changeZoom(event.deltaY < 0 ? .2 : -.2);
      }, { passive: false });
      media.addEventListener("dblclick", () => zoom > 1 ? resetZoom() : changeZoom(1));
      media.addEventListener("pointerdown", event => {
        if (zoom <= 1) return;
        pointerStart = { x: event.clientX - panX, y: event.clientY - panY };
        media.setPointerCapture(event.pointerId);
      });
      media.addEventListener("pointermove", event => {
        if (!pointerStart) return;
        panX = event.clientX - pointerStart.x; panY = event.clientY - pointerStart.y; applyZoom();
      });
      media.addEventListener("pointerup", () => pointerStart = null);
      media.addEventListener("pointercancel", () => pointerStart = null);
    } else if (item.kind === "video") {
      media = document.createElement("video");
      media.src = safeURL(item.path); media.controls = true; media.autoplay = true;
    } else {
      media = document.createElement("audio");
      media.src = safeURL(item.path); media.controls = true; media.autoplay = true;
    }
    viewerContent.append(media);
    caption.textContent = `${item.album} / ${item.name}  ·  ${current + 1} of ${visible.length}`;
    const favButton = $("#viewer-fav");
    favButton.textContent = isFavourite(item.path) ? "♥" : "♡";
    favButton.classList.toggle("is-fav", isFavourite(item.path));
    favButton.setAttribute("aria-label", isFavourite(item.path) ? "Remove from favourites" : "Add to favourites");
    if (!viewer.open) viewer.showModal();
  }
  function step(amount) { openAt(current + amount); }

  $("#close").addEventListener("click", () => viewer.close());
  $("#prev").addEventListener("click", () => step(-1));
  $("#next").addEventListener("click", () => step(1));
  $("#zoom-in").addEventListener("click", () => changeZoom(.25));
  $("#zoom-out").addEventListener("click", () => changeZoom(-.25));
  $("#zoom-reset").addEventListener("click", resetZoom);
  $("#fullscreen").addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await viewer.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) { console.warn("Fullscreen is not available", error); }
  });
  $("#viewer-fav").addEventListener("click", () => {
    if (visible[current]) openAt(current), toggleFavourite(visible[current].path);
  });
  viewer.addEventListener("click", event => { if (event.target === viewer) viewer.close(); });
  search.addEventListener("input", render);
  $("#sort").addEventListener("click", () => {
    sortAscending = !sortAscending;
    $("#sort").textContent = `Name ${sortAscending ? "↑" : "↓"}`;
    render();
  });
  document.addEventListener("keydown", event => {
    if (!viewer.open) return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
    if (event.key === "+" || event.key === "=") changeZoom(.25);
    if (event.key === "-") changeZoom(-.25);
    if (event.key === "0") resetZoom();
  });
  start();
})();
