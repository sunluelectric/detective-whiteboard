"use strict";

const PICTURE_WIDTH = 480; // pictures are scaled down to this width so wider cards still look sharp
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const BOARD_MIN_WIDTH = 4000;
const BOARD_MIN_HEIGHT = 3000;
const BOARD_MARGIN = 400;
const DASHES = { solid: "", dashed: "8 5", dotted: "2 4" };
const SVG_NS = "http://www.w3.org/2000/svg";

let board = null;
let dirty = false;
let zoom = 1;
let linkSource = null; // { card, property }
let selectedLinkId = null;
let pictureCardId = null;
let searchMode = "global"; // one of ops.SEARCH_MODES
let searchQuery = null; // argument for ops.search, or null when the search fields are empty
let found = null; // { cards: Set, properties: Set, links: Set } of IDs from the last search
let chatBoard = null; // the board the assistant is working on, or null
let chatError = null;
let edits = 0; // user edits, so the assistant can tell whether the user changed the board during a turn
let dragging = false;
let renderPending = false; // a render was put off until the current drag ends

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const content = $("content");
const cardsLayer = $("cards");
const linksLayer = $("links");

function findCard(id) {
  return board.cards.find((c) => c.id === id);
}

// After a change made by the user.
function changed() {
  edits++;
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

// ---------- Dialog ----------

let dialogQueue = Promise.resolve();

// Resolves to the trimmed field values on OK, or null on Cancel / Escape. A dialog waits until the open
// one closes, so an assistant confirmation never replaces a dialog the user is filling in.
function showDialog(options) {
  dialogQueue = dialogQueue.then(() => openDialog(options));
  return dialogQueue;
}

function openDialog({ title, message = "", fields = [], ok = "OK", cancel = "Cancel" }) {
  const dialog = $("dialog");
  const inputs = fields.map(({ value = "" }) =>
    el("input", { value, required: "", pattern: ".*\\S.*", title: "Must not be blank", autocomplete: "off" }),
  );
  $("dialog-title").textContent = title;
  $("dialog-message").textContent = message;
  $("dialog-message").hidden = !message;
  $("dialog-fields").replaceChildren(...fields.flatMap(({ label }, i) => [el("label", {}, label), inputs[i]]));
  $("dialog-ok").textContent = ok;
  $("dialog-cancel").textContent = cancel;
  $("dialog-cancel").hidden = !cancel;
  dialog.returnValue = "";
  dialog.showModal();
  inputs[0]?.select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok" ? inputs.map((input) => input.value.trim()) : null),
      { once: true },
    );
  });
}

async function askText(title, label, value) {
  return (await showDialog({ title, fields: [{ label, value }] }))?.[0];
}

async function askConfirm(title, message, ok) {
  return (await showDialog({ title, message, ok })) !== null;
}

function showMessage(title, message) {
  return showDialog({ title, message, cancel: null });
}

// ---------- Whiteboard ----------

async function confirmDiscard() {
  return !board || !dirty || askConfirm("Unsaved changes", "The current whiteboard has unsaved changes. Discard them?", "Discard");
}

// newBoard is checked before it replaces the current board, so bad data leaves the open board untouched.
function openBoard(newBoard) {
  board = newBoard;
  dirty = false;
  chatError = null;
  selectedLinkId = null;
  linkSource = null;
  setZoom(1);
  viewport.scrollTo(0, 0);
  render();
}

async function createBoard() {
  if (!(await confirmDiscard())) return;
  const name = await askText("New whiteboard", "Name");
  if (!name) return;
  openBoard(ops.newBoard(name));
}

async function renameBoard() {
  const name = await askText("Rename whiteboard", "Name", board.name);
  if (!name || name === board.name) return;
  ops.renameBoard(board, name);
  changed();
}

async function saveBoard() {
  const json = JSON.stringify(board, null, 2);
  const fileName = `${board.name}.json`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "Whiteboard JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
    } catch (err) {
      if (err.name !== "AbortError") showMessage("Save failed", `Could not save ${fileName}: ${err.message}`);
      return;
    }
  } else {
    // A download cannot report whether the user kept the file, so it counts as saved.
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    el("a", { href: url, download: fileName }).click();
    URL.revokeObjectURL(url);
  }
  dirty = false;
  renderToolbar();
}

async function loadBoard() {
  if (!(await confirmDiscard())) return;
  $("file-load").click();
}

$("file-load").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    openBoard(ops.loadBoard(JSON.parse(await file.text())));
  } catch (err) {
    showMessage("Load failed", `Could not load ${file.name}: ${err.message}`);
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

async function addCard() {
  const name = await askText("New card", "Name");
  if (!name) return;
  ops.addCard(board, { name, ...newCardPosition() });
  changed();
}

// Near the top left of the visible area, shifted a little for each card so new cards do not stack exactly.
function newCardPosition() {
  const offset = (board.cards.length % 8) * 24;
  return { x: viewport.scrollLeft / zoom + 40 + offset, y: viewport.scrollTop / zoom + 40 + offset };
}

async function renameCard(card) {
  const name = await askText("Rename card", "Name", card.name);
  if (!name || name === card.name) return;
  ops.renameCard(board, card.id, name);
  changed();
}

async function deleteCard(card) {
  if (!(await askConfirm("Delete card", `Delete card "${card.name}" and its links?`, "Delete"))) return;
  ops.deleteCard(board, card.id);
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
    showMessage("Picture failed", `Could not read image ${file.name}`);
    return;
  } finally {
    URL.revokeObjectURL(img.src);
  }
  const scale = Math.min(1, PICTURE_WIDTH / img.naturalWidth);
  const canvas = el("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const picture = file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
  ops.setCardPicture(board, card.id, picture);
  changed();
});

// Follows the pointer from a pointerdown until it is released, calling onMove(dx, dy) with the distance in
// board coordinates. Used for moving and resizing a card.
function trackPointer(event, card, onMove) {
  event.preventDefault();
  dragging = true;
  let moved = false;
  const target = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  target.setPointerCapture(event.pointerId);
  const move = (e) => {
    const dx = (e.clientX - startX) / zoom;
    const dy = (e.clientY - startY) / zoom;
    if (!findCard(card.id) || (!moved && !dx && !dy)) return; // the assistant may have deleted the card
    if (!moved) edits++;
    moved = true;
    onMove(dx, dy);
    renderLinks();
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    dragging = false;
    if (moved) dirty = true;
    if (renderPending) render();
    else renderToolbar();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function startDrag(event, card, cardEl) {
  if (event.button !== 0 || event.target.closest("button") || linkSource) return;
  const origX = card.x;
  const origY = card.y;
  trackPointer(event, card, (dx, dy) => {
    ops.moveCard(board, card.id, origX + dx, origY + dy);
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
  });
}

function startResize(event, card, cardEl) {
  if (event.button !== 0 || linkSource) return;
  const origWidth = cardEl.offsetWidth;
  const origHeight = cardEl.offsetHeight;
  trackPointer(event, card, (dx, dy) => {
    ops.resizeCard(board, card.id, origWidth + dx, origHeight + dy);
    sizeCard(cardEl, card);
  });
}

function fitCardHeight(card) {
  if (card.height === null) return;
  ops.resizeCard(board, card.id, card.width, null);
  changed();
}

function sizeCard(cardEl, card) {
  cardEl.style.width = `${card.width}px`;
  cardEl.style.height = card.height === null ? "" : `${card.height}px`;
  cardEl.classList.toggle("sized", card.height !== null);
}

// ---------- Properties ----------

async function askProperty(title, tag = "", content = "") {
  const values = await showDialog({
    title,
    fields: [
      { label: "Tag", value: tag },
      { label: "Content", value: content },
    ],
  });
  return values && { tag: values[0], content: values[1] };
}

async function addProperty(card) {
  const values = await askProperty("New property");
  if (!values) return;
  ops.addProperty(board, card.id, values);
  changed();
}

async function editProperty(card, prop) {
  const values = await askProperty("Edit property", prop.tag, prop.content);
  if (!values) return;
  ops.editProperty(board, card.id, prop.id, values);
  changed();
}

async function deleteProperty(card, prop) {
  if (!(await askConfirm("Delete property", `Delete property "${prop.tag}" and its links?`, "Delete"))) return;
  ops.deleteProperty(board, card.id, prop.id);
  changed();
}

function moveProperty(card, prop, index, delta) {
  if (index + delta < 0 || index + delta >= card.properties.length) return;
  ops.moveProperty(board, card.id, prop.id, index + delta);
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
  ops.addLink(board, source, target);
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
  linkSource = null;
  selectedLinkId = id;
  render();
}

function selectedLink() {
  return board?.links.find((l) => l.id === selectedLinkId);
}

function updateLink(changes) {
  ops.updateLink(board, selectedLinkId, changes);
  changed();
}

// Saved on Enter or when the field loses focus; Escape deselects the link first, which drops the edit.
$("link-message").addEventListener("change", (event) => {
  if (selectedLink() && event.target.value.trim() !== selectedLink().message) updateLink({ message: event.target.value });
});
$("link-message").addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.target.blur();
});

viewport.addEventListener("click", (event) => {
  if (event.target.closest(".card") || event.target.closest("#links g")) return;
  if (linkSource) cancelLink();
  else if (selectedLinkId) selectLink(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("dialog").open) return;
  if (linkSource) cancelLink();
  else if (selectedLinkId) selectLink(null);
});

window.addEventListener("beforeunload", (event) => {
  if (board && dirty) event.preventDefault();
});

// A user action can fail when the assistant deleted its card, property or link while a dialog was open.
window.addEventListener("unhandledrejection", (event) => showMessage("Error", event.reason?.message ?? String(event.reason)));

// ---------- Search ----------

// Builds the search query from the current tab and fields.
function updateSearch() {
  const keyword = $("search-input").value.trim();
  const tag = $("search-tag").value.trim();
  const content = $("search-content").value.trim();
  const active = searchMode === "property" ? tag : keyword;
  searchQuery = active ? { mode: searchMode, keyword, tag, content } : null;
  render();
}

// Runs the search on the current board, so highlights follow every change.
function runSearch() {
  if (!board || !searchQuery) {
    found = null;
    return;
  }
  const result = ops.search(board, searchQuery);
  found = {
    cards: new Set(result.cards),
    properties: new Set(result.properties.map((p) => p.property)),
    links: new Set(result.links),
  };
}

function renderSearchCount() {
  const count = found ? found.cards.size + found.properties.size + found.links.size : 0;
  $("search-count").textContent = !found ? "" : count === 0 ? "No matches" : `${count} match${count === 1 ? "" : "es"}`;
}

for (const id of ["search-input", "search-tag", "search-content"]) $(id).addEventListener("input", updateSearch);

for (const tab of $("search-tabs").children) {
  tab.addEventListener("click", () => {
    searchMode = tab.dataset.mode;
    for (const other of $("search-tabs").children) other.classList.toggle("active", other === tab);
    const isProperty = searchMode === "property";
    $("search-input").hidden = isProperty;
    $("search-tag").hidden = !isProperty;
    $("search-content").hidden = !isProperty;
    $(isProperty ? "search-tag" : "search-input").focus();
    updateSearch();
  });
}

$("search-toggle").addEventListener("click", () => {
  const collapsed = $("search").classList.toggle("collapsed");
  $("search-toggle").textContent = collapsed ? "Search" : "−";
  $("search-toggle").title = collapsed ? "Show search" : "Minimize search";
  if (!collapsed) $(searchMode === "property" ? "search-tag" : "search-input").focus();
});

// ---------- Assistant ----------

// The user can keep working while the assistant waits for the model. If they change the board (or open
// another one), the assistant's remaining changes in this turn are blocked; see assistant.send.
async function sendChat() {
  const text = $("chat-input").value.trim();
  if (!text || !board || chatBoard) return;
  $("chat-input").value = "";
  const turnBoard = board;
  const start = edits;
  chatBoard = turnBoard;
  chatError = null;
  let error = null;
  try {
    await assistant.send(turnBoard, text, {
      onUpdate: () => {
        if (board === turnBoard) dirty = true;
        render();
      },
      confirm: (question) => askConfirm("Assistant", question, "Allow"),
      cardPosition: newCardPosition,
      stale: () => board !== turnBoard || edits !== start,
      model: $("chat-model").value,
    });
  } catch (err) {
    error = err.message;
  }
  chatBoard = null;
  if (board === turnBoard) chatError = error;
  render();
  if (document.activeElement === document.body) $("chat-input").focus();
}

async function clearChat() {
  if (!board.chat.length) return;
  if (!(await askConfirm("Clear chat", "Delete the whole chat history of this whiteboard?", "Clear"))) return;
  ops.clearChat(board);
  chatError = null;
  changed();
}

// One short line per function call, e.g. "add card: Alice", marked as failed when the tool returned an error.
function actionLine(call, results) {
  let args = {};
  try {
    args = JSON.parse(call.arguments);
  } catch {}
  const detail = args.name ?? (args.tag ? `${args.tag}${args.content ? `: ${args.content}` : ""}` : args.keyword) ?? "";
  const result = results.get(call.call_id);
  const label = call.name.replaceAll("_", " ") + (detail ? `: ${detail}` : "");
  if (!result?.error) return el("div", { class: "msg action" }, label);
  return el("div", { class: "msg action failed" }, `${label} (${result.blocked ? "blocked" : result.error})`);
}

let renderedChat = []; // what the chat panel shows, so it is rebuilt and scrolled only when that changes

function renderChat() {
  const chat = board?.chat ?? [];
  const busy = !!board && chatBoard === board;
  const state = [board, chat, chat.length, busy, !!chatBoard, chatError];
  if (state.every((value, i) => value === renderedChat[i])) return;
  renderedChat = state;
  const outputs = chat.filter((item) => item.type === "function_call_output");
  const results = new Map(outputs.map((item) => [item.call_id, JSON.parse(item.output)]));
  const nodes = [];
  // Reasoning items are kept for the model but not shown.
  for (const item of chat) {
    if (item.role === "user") nodes.push(el("div", { class: "msg user" }, item.content));
    else if (item.type === "message") nodes.push(el("div", { class: "msg assistant" }, assistant.messageText(item)));
    else if (item.type === "function_call") nodes.push(actionLine(item, results));
    else if (item.type === "notice") nodes.push(el("div", { class: "msg notice" }, item.text));
  }
  if (busy) nodes.push(el("div", { class: "msg status" }, "Working..."));
  if (chatError) nodes.push(el("div", { class: "msg error" }, chatError));
  const list = $("chat-messages");
  list.replaceChildren(...nodes);
  list.scrollTop = list.scrollHeight;
  // The text box stays enabled so the next message can be written while the assistant works.
  $("chat-input").disabled = !board;
  for (const id of ["chat-send", "chat-clear", "chat-model"]) $(id).disabled = !board || !!chatBoard;
}

// Fills the model dropdown from the server; if that fails it stays hidden and the server's default is used.
async function loadModels() {
  try {
    const { models, default: chosen } = await (await fetch("/api/models")).json();
    $("chat-model").replaceChildren(...models.map((model) => el("option", { value: model }, model)));
    $("chat-model").value = chosen;
  } catch {}
}

loadModels();

$("chat-toggle").addEventListener("click", () => {
  const collapsed = $("chat").classList.toggle("collapsed");
  $("chat-toggle").textContent = collapsed ? "+" : "\u2212";
  $("chat-toggle").title = collapsed ? "Show assistant" : "Minimize assistant";
  if (!collapsed) $("chat-input").focus();
});
$("chat-clear").addEventListener("click", clearChat);
$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat();
});
$("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
});

// ---------- Rendering ----------

function endpointExists({ card, property }) {
  const found = findCard(card);
  return !!found && (!property || found.properties.some((p) => p.id === property));
}

function render() {
  // Rebuilding the cards would end a drag, so the board is redrawn when the drag ends.
  if (dragging) {
    renderPending = true;
    renderToolbar();
    renderChat();
    return;
  }
  renderPending = false;
  if (linkSource && !endpointExists(linkSource)) linkSource = null;
  runSearch();
  renderToolbar();
  renderCards();
  renderLinks();
  renderLinkPanel();
  renderSearchCount();
  renderChat();
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
  if (found?.cards.has(card.id)) cardEl.classList.add("highlight");
  cardEl.style.left = `${card.x}px`;
  cardEl.style.top = `${card.y}px`;
  sizeCard(cardEl, card);

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

  // A card with a fixed height scrolls its properties, and links to them follow.
  const list = el("ul", { class: "properties", onscroll: renderLinks });
  card.properties.forEach((prop, index) => {
    const row = el(
      "li",
      { class: "property", "data-id": prop.id },
      el("span", { class: "property-text" }, el("b", {}, `${prop.tag}:`), ` ${prop.content}`),
      iconButton("↑", "Move up", () => moveProperty(card, prop, index, -1)),
      iconButton("↓", "Move down", () => moveProperty(card, prop, index, 1)),
      iconButton("✎", "Edit property", () => editProperty(card, prop)),
      iconButton("⤳", "Add link", () => startLink(card.id, prop.id)),
      iconButton("×", "Delete property", () => deleteProperty(card, prop)),
    );
    if (isSource && linkSource.property === prop.id) row.classList.add("link-source");
    if (found?.properties.has(prop.id)) row.classList.add("highlight");
    list.append(row);
  });

  const addButton = el("button", { class: "add-property", onclick: () => addProperty(card) }, "+ Add property");
  const resizer = el("div", {
    class: "resizer",
    title: "Drag to resize; double-click to fit the height to the content",
    onpointerdown: (e) => startResize(e, card, cardEl),
    ondblclick: () => fitCardHeight(card),
  });
  cardEl.append(header, picture, list, addButton, resizer);
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
  const cardEl = cardsLayer.querySelector(`.card[data-id="${CSS.escape(endpoint.card)}"]`);
  const node = endpoint.property
    ? cardEl?.querySelector(`.property[data-id="${CSS.escape(endpoint.property)}"]`)
    : cardEl;
  // Missing while a drag puts off drawing cards the assistant added.
  if (!node) return null;
  const rect = boardRect(node);
  if (endpoint.property) {
    // A property scrolled out of view in a card with a fixed height is anchored at the card's edge.
    const card = boardRect(cardEl);
    rect.cy = Math.min(Math.max(rect.cy, card.y), card.y + card.h);
  }
  return { rect, isProperty: !!endpoint.property };
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

// The board keeps a minimum size and grows to leave a margin past the farthest card.
function fitContent() {
  let width = BOARD_MIN_WIDTH;
  let height = BOARD_MIN_HEIGHT;
  for (const cardEl of cardsLayer.children) {
    width = Math.max(width, cardEl.offsetLeft + cardEl.offsetWidth + BOARD_MARGIN);
    height = Math.max(height, cardEl.offsetTop + cardEl.offsetHeight + BOARD_MARGIN);
  }
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
}

function renderLinks() {
  fitContent();
  linksLayer.replaceChildren();
  if (!board) return;
  const defs = svg("defs", {});
  linksLayer.append(defs);
  for (const link of board.links) {
    const a = endpointRect(link.source);
    const b = endpointRect(link.target);
    if (!a || !b) continue;
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

    const group = svg("g", {});
    group.classList.toggle("selected", link.id === selectedLinkId);
    group.classList.toggle("highlight", !!found?.links.has(link.id));
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      selectLink(link.id);
    });
    group.append(svg("line", { ...coords, class: "hit" }), line);
    linksLayer.append(group);
    if (link.message) {
      const label = svg("text", { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, class: "label", fill: link.color });
      label.textContent = link.message;
      group.append(label);
      // A box behind the text hides the line, which would otherwise show between the words.
      const box = label.getBBox();
      label.before(svg("rect", { x: box.x - 4, y: box.y - 1, width: box.width + 8, height: box.height + 2, rx: 3, class: "label-box" }));
    }
  }
}

function renderLinkPanel() {
  const link = selectedLink();
  $("link-panel").hidden = !link;
  if (!link) return;
  const swatches = Object.entries(ops.COLORS).map(([name, value]) => {
    const swatch = el("button", {
      class: "swatch" + (link.color === value ? " active" : ""),
      title: name,
      onclick: () => updateLink({ color: value }),
    });
    swatch.style.background = value;
    return swatch;
  });
  $("link-colors").replaceChildren(...swatches);
  // Not overwritten while the user is typing in it.
  if (document.activeElement !== $("link-message")) $("link-message").value = link.message;
  $("link-style").value = link.style;
  $("link-direction").value = link.direction;
}

$("link-style").addEventListener("change", (e) => updateLink({ style: e.target.value }));
$("link-direction").addEventListener("change", (e) => updateLink({ direction: e.target.value }));
$("link-delete").addEventListener("click", () => {
  ops.deleteLink(board, selectedLinkId);
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
