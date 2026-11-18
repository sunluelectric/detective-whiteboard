"use strict";

const CARD_WIDTH = 220;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const COLORS = {
  black: "#000000",
  red: "#d32f2f",
  blue: "#1e6fd9",
  green: "#2e7d32",
  orange: "#ef6c00",
  purple: "#7b1fa2",
  gray: "#757575",
};
const DASHES = { solid: "", dashed: "8 5", dotted: "2 4" };
const SVG_NS = "http://www.w3.org/2000/svg";

let board = null;
let dirty = false;
let zoom = 1;
let linkSource = null; // { card, property }
let selectedLinkId = null;
let pictureCardId = null;

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const content = $("content");
const cardsLayer = $("cards");
const linksLayer = $("links");

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function findCard(id) {
  return board.cards.find((c) => c.id === id);
}

function changed() {
  dirty = true;
  render();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function iconButton(text, title, onclick) {
  return el("button", { class: "icon", title, onclick }, text);
}

// ---------- Whiteboard ----------

function confirmDiscard() {
  return !board || !dirty || confirm("The current whiteboard has unsaved changes. Discard them?");
}

function openBoard(data) {
  board = data;
  dirty = false;
  selectedLinkId = null;
  linkSource = null;
  setZoom(1);
  viewport.scrollTo(0, 0);
  render();
}

function createBoard() {
  if (!confirmDiscard()) return;
  const name = prompt("Whiteboard name:")?.trim();
  if (!name) return;
  openBoard({ version: 1, name, cards: [], links: [] });
}

function renameBoard() {
  const name = prompt("New whiteboard name:", board.name)?.trim();
  if (!name || name === board.name) return;
  board.name = name;
  changed();
}

async function saveBoard() {
  const json = JSON.stringify(board, null, 2);
  const fileName = `${board.name}.json`;
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "Whiteboard JSON", accept: { "application/json": [".json"] } }],
      });
    } catch (err) {
      if (err.name === "AbortError") return;
      throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    el("a", { href: url, download: fileName }).click();
    URL.revokeObjectURL(url);
  }
  dirty = false;
  renderToolbar();
}

function loadBoard() {
  if (!confirmDiscard()) return;
  $("file-load").click();
}

$("file-load").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    openBoard(JSON.parse(await file.text()));
  } catch (err) {
    alert(`Could not load ${file.name}: ${err.message}`);
  }
});

// ---------- Zoom ----------

function setZoom(value, clientX, clientY) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
  const vr = viewport.getBoundingClientRect();
  const ax = clientX === undefined ? vr.width / 2 : clientX - vr.left;
  const ay = clientY === undefined ? vr.height / 2 : clientY - vr.top;
  const bx = (viewport.scrollLeft + ax) / zoom;
  const by = (viewport.scrollTop + ay) / zoom;
  zoom = next;
  content.style.transform = `scale(${zoom})`;
  viewport.scrollLeft = bx * zoom - ax;
  viewport.scrollTop = by * zoom - ay;
  $("btn-zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
}

viewport.addEventListener(
  "wheel",
  (event) => {
    if (!board || !event.ctrlKey) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
  },
  { passive: false },
);

// ---------- Cards ----------

function addCard() {
  const name = prompt("Card name:")?.trim();
  if (!name) return;
  const offset = (board.cards.length % 8) * 24;
  board.cards.push({
    id: uid("c"),
    name,
    x: Math.round(viewport.scrollLeft / zoom + 40 + offset),
    y: Math.round(viewport.scrollTop / zoom + 40 + offset),
    picture: null,
    properties: [],
  });
  changed();
}

function renameCard(card) {
  const name = prompt("New card name:", card.name)?.trim();
  if (!name || name === card.name) return;
  card.name = name;
  changed();
}

function deleteCard(card) {
  if (!confirm(`Delete card "${card.name}" and its links?`)) return;
  board.cards = board.cards.filter((c) => c !== card);
  board.links = board.links.filter((l) => l.source.card !== card.id && l.target.card !== card.id);
  changed();
}

function choosePicture(card) {
  pictureCardId = card.id;
  $("file-picture").click();
}

$("file-picture").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  const card = file && findCard(pictureCardId);
  if (!card) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
  } catch {
    alert(`Could not read image ${file.name}`);
    return;
  } finally {
    URL.revokeObjectURL(img.src);
  }
  const scale = Math.min(1, CARD_WIDTH / img.naturalWidth);
  const canvas = el("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  card.picture = file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
  changed();
});

function startDrag(event, card, cardEl) {
  if (event.button !== 0 || event.target.closest("button") || linkSource) return;
  event.preventDefault();
  const header = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  const origX = card.x;
  const origY = card.y;
  header.setPointerCapture(event.pointerId);
  const move = (e) => {
    card.x = Math.max(0, Math.round(origX + (e.clientX - startX) / zoom));
    card.y = Math.max(0, Math.round(origY + (e.clientY - startY) / zoom));
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    renderLinks();
  };
  const up = () => {
    header.removeEventListener("pointermove", move);
    header.removeEventListener("pointerup", up);
    if (card.x !== origX || card.y !== origY) {
      dirty = true;
      renderToolbar();
    }
  };
  header.addEventListener("pointermove", move);
  header.addEventListener("pointerup", up);
}

// ---------- Properties ----------

function askProperty(tag = "", content = "") {
  const newTag = prompt("Tag:", tag)?.trim();
  if (!newTag) return null;
  const newContent = prompt("Content:", content)?.trim();
  if (!newContent) return null;
  return { tag: newTag, content: newContent };
}

function addProperty(card) {
  const values = askProperty();
  if (!values) return;
  card.properties.push({ id: uid("p"), ...values });
  changed();
}

function editProperty(prop) {
  const values = askProperty(prop.tag, prop.content);
  if (!values) return;
  Object.assign(prop, values);
  changed();
}

function deleteProperty(card, prop) {
  card.properties = card.properties.filter((p) => p !== prop);
  board.links = board.links.filter((l) => l.source.property !== prop.id && l.target.property !== prop.id);
  changed();
}

function moveProperty(card, index, delta) {
  const other = index + delta;
  if (other < 0 || other >= card.properties.length) return;
  const props = card.properties;
  [props[index], props[other]] = [props[other], props[index]];
  changed();
}

// ---------- Links ----------

function startLink(cardId, propertyId) {
  linkSource = { card: cardId, property: propertyId };
  selectedLinkId = null;
  render();
}

function cancelLink() {
  if (!linkSource) return;
  linkSource = null;
  render();
}

function finishLink(target) {
  const source = linkSource;
  linkSource = null;
  if (target.card === source.card) {
    render();
    return;
  }
  board.links.push({ id: uid("l"), source, target, color: COLORS.black, style: "solid", direction: "forward" });
  changed();
}

// While linking, clicks on cards pick the target instead of triggering buttons.
cardsLayer.addEventListener(
  "click",
  (event) => {
    if (!linkSource) return;
    const cardEl = event.target.closest(".card");
    if (!cardEl) return;
    event.stopPropagation();
    event.preventDefault();
    const propEl = event.target.closest(".property");
    finishLink({ card: cardEl.dataset.id, property: propEl ? propEl.dataset.id : null });
  },
  true,
);

function selectLink(id) {
  selectedLinkId = id;
  render();
}

function selectedLink() {
  return board?.links.find((l) => l.id === selectedLinkId);
}

function updateLink(changes) {
  Object.assign(selectedLink(), changes);
  changed();
}

viewport.addEventListener("click", (event) => {
  if (event.target.closest(".card") || event.target.closest("#links g")) return;
  if (linkSource) cancelLink();
  else if (selectedLinkId) selectLink(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (linkSource) cancelLink();
  else if (selectedLinkId) selectLink(null);
});

window.addEventListener("beforeunload", (event) => {
  if (board && dirty) event.preventDefault();
});

// ---------- Rendering ----------

function render() {
  renderToolbar();
  renderCards();
  renderLinks();
  renderLinkPanel();
}

function renderToolbar() {
  for (const button of document.querySelectorAll("[data-needs-board]")) button.disabled = !board;
  $("board-name").textContent = board ? board.name + (dirty ? " *" : "") : "";
  $("status").textContent = linkSource ? "Click a card or property to link to (Esc to cancel)" : "";
  $("empty-hint").hidden = !!board;
  document.body.classList.toggle("linking", !!linkSource);
}

function renderCards() {
  cardsLayer.replaceChildren();
  if (!board) return;
  for (const card of board.cards) cardsLayer.append(renderCard(card));
}

function renderCard(card) {
  const isSource = linkSource && linkSource.card === card.id;
  const cardEl = el("div", { class: "card", "data-id": card.id });
  if (isSource && !linkSource.property) cardEl.classList.add("link-source");
  cardEl.style.left = `${card.x}px`;
  cardEl.style.top = `${card.y}px`;
  cardEl.style.width = `${CARD_WIDTH}px`;

  const header = el(
    "div",
    { class: "card-header", onpointerdown: (e) => startDrag(e, card, cardEl) },
    el("span", { class: "card-name", title: card.name }, card.name),
    iconButton("✎", "Rename card", () => renameCard(card)),
    iconButton("⤳", "Add link", () => startLink(card.id, null)),
    iconButton("×", "Delete card", () => deleteCard(card)),
  );

  const picture = el("div", { class: "picture" });
  if (card.picture) {
    const img = el("img", { src: card.picture, alt: card.name, draggable: "false" });
    img.addEventListener("load", renderLinks);
    picture.append(img);
  } else {
    picture.append(el("span", { class: "empty" }, "No picture"));
  }
  picture.append(iconButton("Picture", "Update picture", () => choosePicture(card)));

  const list = el("ul", { class: "properties" });
  card.properties.forEach((prop, index) => {
    const row = el(
      "li",
      { class: "property", "data-id": prop.id },
      el("span", { class: "property-text" }, el("b", {}, `${prop.tag}:`), ` ${prop.content}`),
      iconButton("↑", "Move up", () => moveProperty(card, index, -1)),
      iconButton("↓", "Move down", () => moveProperty(card, index, 1)),
      iconButton("✎", "Edit property", () => editProperty(prop)),
      iconButton("⤳", "Add link", () => startLink(card.id, prop.id)),
      iconButton("×", "Delete property", () => deleteProperty(card, prop)),
    );
    if (isSource && linkSource.property === prop.id) row.classList.add("link-source");
    list.append(row);
  });

  const addButton = el("button", { class: "add-property", onclick: () => addProperty(card) }, "+ Add property");
  cardEl.append(header, picture, list, addButton);
  return cardEl;
}

// Rectangle of an element in board coordinates.
function boardRect(node) {
  const r = node.getBoundingClientRect();
  const c = content.getBoundingClientRect();
  const x = (r.left - c.left) / zoom;
  const y = (r.top - c.top) / zoom;
  const w = r.width / zoom;
  const h = r.height / zoom;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function endpointRect(endpoint) {
  const cardEl = cardsLayer.querySelector(`.card[data-id="${endpoint.card}"]`);
  const node = endpoint.property ? cardEl.querySelector(`.property[data-id="${endpoint.property}"]`) : cardEl;
  return { rect: boardRect(node), isProperty: !!endpoint.property };
}

// Point where the line from the rect center towards (px, py) leaves the rect.
function anchor({ rect, isProperty }, px, py) {
  if (isProperty) return { x: px < rect.cx ? rect.x : rect.x + rect.w, y: rect.cy };
  const dx = px - rect.cx;
  const dy = py - rect.cy;
  if (dx === 0 && dy === 0) return { x: rect.cx, y: rect.cy };
  const t = Math.min(rect.w / 2 / Math.abs(dx || 1e-9), rect.h / 2 / Math.abs(dy || 1e-9));
  return { x: rect.cx + dx * t, y: rect.cy + dy * t };
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderLinks() {
  linksLayer.replaceChildren();
  if (!board) return;
  const defs = svg("defs", {});
  linksLayer.append(defs);
  for (const link of board.links) {
    const a = endpointRect(link.source);
    const b = endpointRect(link.target);
    const p1 = anchor(a, b.rect.cx, b.rect.cy);
    const p2 = anchor(b, a.rect.cx, a.rect.cy);
    const markerId = `arrow-${link.id}`;
    const marker = svg("marker", {
      id: markerId,
      viewBox: "0 0 10 10",
      refX: 10,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: "auto-start-reverse",
    });
    marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", fill: link.color }));
    defs.append(marker);

    const coords = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    const line = svg("line", { ...coords, class: "line", stroke: link.color, "stroke-dasharray": DASHES[link.style] });
    if (link.style === "dotted") line.setAttribute("stroke-linecap", "round");
    if (link.direction === "forward") line.setAttribute("marker-end", `url(#${markerId})`);
    if (link.direction === "backward") line.setAttribute("marker-start", `url(#${markerId})`);

    const group = svg("g", { class: link.id === selectedLinkId ? "selected" : "" });
    const hit = svg("line", { ...coords, class: "hit" });
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      selectLink(link.id);
    });
    group.append(hit, line);
    linksLayer.append(group);
  }
}

function renderLinkPanel() {
  const link = selectedLink();
  $("link-panel").hidden = !link;
  if (!link) return;
  const swatches = Object.entries(COLORS).map(([name, value]) => {
    const swatch = el("button", {
      class: "swatch" + (link.color === value ? " active" : ""),
      title: name,
      onclick: () => updateLink({ color: value }),
    });
    swatch.style.background = value;
    return swatch;
  });
  $("link-colors").replaceChildren(...swatches);
  $("link-style").value = link.style;
  $("link-direction").value = link.direction;
}

$("link-style").addEventListener("change", (e) => updateLink({ style: e.target.value }));
$("link-direction").addEventListener("change", (e) => updateLink({ direction: e.target.value }));
$("link-delete").addEventListener("click", () => {
  board.links = board.links.filter((l) => l.id !== selectedLinkId);
  selectedLinkId = null;
  changed();
});

// ---------- Toolbar ----------

$("btn-create").addEventListener("click", createBoard);
$("btn-load").addEventListener("click", loadBoard);
$("btn-save").addEventListener("click", saveBoard);
$("btn-rename").addEventListener("click", renameBoard);
$("btn-add-card").addEventListener("click", addCard);
$("btn-zoom-in").addEventListener("click", () => setZoom(zoom + 0.1));
$("btn-zoom-out").addEventListener("click", () => setZoom(zoom - 0.1));
$("btn-zoom-reset").addEventListener("click", () => setZoom(1));

render();
