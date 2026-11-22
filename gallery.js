const gallery = document.querySelector("#gallery");
const search = document.querySelector("#search");
const count = document.querySelector("#count");
const empty = document.querySelector("#empty");
const loading = document.querySelector("#loading");
const viewer = document.querySelector("#viewer");
const viewerContent = document.querySelector("#viewer-content");
const caption = document.querySelector("#caption");

let items = [];
let visible = [];
let current = 0;

const kindOf = (path) => {
  const ext = path.split(".").pop().toLowerCase();
  if (["jpg","jpeg","png","gif","webp","avif","bmp","svg"].includes(ext)) return "image";
  if (["mp4","webm","ogv","mov","m4v"].includes(ext)) return "video";
  if (["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return "audio";
  return null;
};

async function start() {
  try {
    const response = await fetch("./media.json", { cache: "no-store" });
    if (!response.ok) throw new Error("media.json não encontrado");
    const paths = await response.json();
    items = paths.map(path => ({ path, kind: kindOf(path), name: path.split("/").pop() }))
      .filter(item => item.kind);
    loading.hidden = true;
    render();
  } catch (error) {
    loading.textContent = "Não foi possível carregar media.json. Rode generate_manifest.py e publique novamente.";
    console.error(error);
  }
}

function render() {
  const term = search.value.trim().toLocaleLowerCase("pt-BR");
  visible = items.filter(item => item.name.toLocaleLowerCase("pt-BR").includes(term));
  gallery.replaceChildren();
  count.textContent = `${visible.length} ${visible.length === 1 ? "arquivo" : "arquivos"}`;
  empty.hidden = visible.length !== 0;

  for (const [index, item] of visible.entries()) {
    const button = document.createElement("button");
    button.className = "tile";
    button.type = "button";
    button.title = item.name;
    if (item.kind === "image") {
      const img = document.createElement("img");
      img.src = encodeURI(item.path);
      img.alt = item.name;
      img.loading = "lazy";
      button.append(img);
    } else if (item.kind === "video") {
      const video = document.createElement("video");
      video.src = encodeURI(item.path);
      video.muted = true;
      video.preload = "metadata";
      button.append(video);
    } else {
      const label = document.createElement("div");
      label.className = "audio-label";
      label.textContent = item.name;
      const audio = document.createElement("audio");
      audio.src = encodeURI(item.path);
      audio.controls = true;
      audio.addEventListener("click", event => event.stopPropagation());
      button.append(label, audio);
    }
    button.addEventListener("click", () => openAt(index));
    gallery.append(button);
  }
}

function openAt(index) {
  if (!visible.length) return;
  current = (index + visible.length) % visible.length;
  const item = visible[current];
  viewerContent.replaceChildren();
  let media;
  if (item.kind === "image") {
    media = document.createElement("img");
    media.src = encodeURI(item.path);
    media.alt = item.name;
  } else if (item.kind === "video") {
    media = document.createElement("video");
    media.src = encodeURI(item.path);
    media.controls = true;
    media.autoplay = true;
  } else {
    media = document.createElement("audio");
    media.src = encodeURI(item.path);
    media.controls = true;
    media.autoplay = true;
  }
  viewerContent.append(media);
  caption.textContent = `${item.name}  ·  ${current + 1} / ${visible.length}`;
  if (!viewer.open) viewer.showModal();
}
function step(amount) { openAt(current + amount); }

document.querySelector("#close").addEventListener("click", () => viewer.close());
document.querySelector("#prev").addEventListener("click", () => step(-1));
document.querySelector("#next").addEventListener("click", () => step(1));
viewer.addEventListener("click", event => { if (event.target === viewer) viewer.close(); });
search.addEventListener("input", render);
document.addEventListener("keydown", event => {
  if (!viewer.open) return;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});
start();
