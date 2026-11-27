"use strict";

const PICTURE_WIDTH = 480; // pictures are scaled down to this width so wider cards still look sharp
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const GRID = 24; // spacing of the background dots
const LINKS_MARGIN = 20; // room around the cards for arrowheads on the links layer
const DASHES = { solid: "", dashed: "8 5", dotted: "2 4" };
const SVG_NS = "http://www.w3.org/2000/svg";

let board = null;
let boardId = null; // the open whiteboard's ID on the server
let projectId = null; // the ID of its project
let projects = []; // [{ id, name, boards: [{ id, name }] }] for the sidebar
let expanded = new Set(); // IDs of the projects expanded in the sidebar
let dirty = false; // the open whiteboard has changes that are not sent to the server yet
let zoom = 1;
let view = { x: 0, y: 0 }; // the board point at the top left of the viewport
let selected = new Set(); // IDs of the selected cards
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
  scheduleSave();
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

// Resolves to collect() on OK, or null on Cancel / Escape. body is put in a two-column grid of labels and
// inputs. A dialog waits until the open one closes, so an assistant confirmation never replaces a dialog
// the user is filling in.
function showDialog(options) {
  dialogQueue = dialogQueue.then(() => openDialog(options));
  return dialogQueue;
}

// alt is the label of an optional third button; choosing it resolves to "alt".
function openDialog({ title, message = "", body = [], collect = () => true, ok = "OK", cancel = "Cancel", alt = null }) {
  const dialog = $("dialog");
  $("dialog-title").textContent = title;
  $("dialog-message").textContent = message;
  $("dialog-message").hidden = !message;
  $("dialog-fields").replaceChildren(...body);
  $("dialog-ok").textContent = ok;
  $("dialog-cancel").textContent = cancel;
  $("dialog-cancel").hidden = !cancel;
  $("dialog-alt").textContent = alt ?? "";
  $("dialog-alt").hidden = !alt;
  dialog.returnValue = "";
  dialog.showModal();
  $("dialog-fields").querySelector("input")?.select();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve({ ok: collect, alt: () => "alt" }[dialog.returnValue]?.() ?? null), { once: true });
  });
}

// Blank input is rejected unless the field is optional.
function textInput(value = "", optional = false) {
  const input = el("input", { value, autocomplete: "off" });
  if (!optional) Object.assign(input, { required: true, pattern: ".*\\S.*", title: "Must not be blank" });
  return input;
}

// fields: [{ label, value, optional }]. Resolves to the trimmed values.
function askFields(title, fields) {
  const inputs = fields.map(({ value, optional }) => textInput(value, optional));
  return showDialog({
    title,
    body: fields.flatMap(({ label }, i) => [el("label", {}, label), inputs[i]]),
    collect: () => inputs.map((input) => input.value.trim()),
  });
}

async function askText(title, label, value) {
  return (await askFields(title, [{ label, value }]))?.[0];
}

async function askConfirm(title, message, ok) {
  return (await showDialog({ title, message, ok })) !== null;
}

function showMessage(title, message) {
  return showDialog({ title, message, cancel: null });
}

// ---------- Storage on the server ----------

// The open whiteboard is saved SAVE_DELAY after the last change, and at once when another one is opened or
// the page is left. dirty means it has changes that are not sent yet.
const SAVE_DELAY = 1000;
const RETRY_DELAY = 5000;
let saveTimer = null;
let saving = 0; // saves sent and not answered yet
let saveError = null; // message of the last failed save of the open whiteboard
let serverQueue = Promise.resolve();

// Server requests run one after another, so a save never overtakes an earlier save, rename or delete.
function queued(task) {
  const result = serverQueue.then(task);
  serverQueue = result.catch(() => {});
  return result;
}

// body is a JSON string. Throws an Error with the server's message and the HTTP status.
async function api(method, path, body) {
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  const response = await fetch(path, { method, headers, body });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message ?? `Request failed with status ${response.status}`), {
      status: response.status,
    });
  }
  return data;
}

const send = (method, path, body) => queued(() => api(method, path, body === undefined ? undefined : JSON.stringify(body)));
const boardUrl = (id) => `/api/boards/${id}`;
const projectUrl = (id) => `/api/projects/${id}`;

function scheduleSave(delay = SAVE_DELAY) {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}

// Sends the open whiteboard if it has unsent changes. Resolves once every request sent so far is answered.
function saveNow() {
  clearTimeout(saveTimer);
  if (!board || !dirty) return queued(() => {});
  const target = board;
  const id = boardId;
  const json = JSON.stringify(board);
  dirty = false;
  saving++;
  renderToolbar();
  return queued(() => api("PUT", boardUrl(id), json)).then(
    () => {
      saving--;
      if (board === target) saveError = null;
      renderToolbar();
    },
    (err) => {
      saving--;
      if (board === target) {
        saveError = err.message;
        scheduleSave(RETRY_DELAY);
      }
      renderToolbar();
    },
  );
}

// Sends the open whiteboard's changes before another one is opened. Resolves to false if the user stays.
async function leaveBoard() {
  if (!board) return true;
  await saveNow();
  return (
    !saveError ||
    askConfirm("Save failed", `The latest changes to "${board.name}" could not be saved: ${saveError}`, "Leave anyway")
  );
}

// ---------- Projects and whiteboards ----------

// Reloads the projects and their whiteboards for the sidebar. Resolves to the server's reply.
async function refreshProjects() {
  const data = await api("GET", "/api/projects");
  projects = data.projects;
  render();
  return data;
}

const findProject = (id) => projects.find((p) => p.id === id);

// newBoard is checked before it replaces the current board, so bad data leaves the open board untouched.
// keepView keeps the zoom and position, for a copy made by Save As.
function openBoard(newBoard, id, project, keepView = false) {
  clearTimeout(saveTimer);
  board = newBoard;
  boardId = id;
  projectId = project;
  expanded.add(project);
  dirty = false;
  saveError = null;
  chatError = null;
  selectedLinkId = null;
  linkSource = null;
  selected.clear();
  send("PUT", "/api/last", { board: id }).catch(() => {});
  if (!keepView) {
    // An opened board starts with its top-left card in view.
    const cards = newBoard.cards;
    zoom = 1;
    setView(
      cards.length ? Math.min(...cards.map((c) => c.x)) - 40 : 0,
      cards.length ? Math.min(...cards.map((c) => c.y)) - 40 : 0,
    );
  }
  render();
}

function closeBoard() {
  clearTimeout(saveTimer);
  board = null;
  boardId = null;
  projectId = null;
  dirty = false;
  saveError = null;
  chatError = null;
  selectedLinkId = null;
  linkSource = null;
  selected.clear();
  edits++;
  render();
}

// Asks for a project or whiteboard name until use(name) succeeds or the user cancels; a refused name (blank,
// forbidden characters, already taken) is reported and asked again.
async function withName(title, value, use) {
  for (;;) {
    const name = await askText(title, "Name", value);
    if (!name) return;
    try {
      return await use(ops.boardName(name));
    } catch (err) {
      await showMessage(title, err.message);
      value = name;
    }
  }
}

async function createProject() {
  await withName("New project", "", async (name) => {
    const { id } = await send("POST", "/api/projects", { name });
    expanded.add(id);
    await refreshProjects();
  });
}

async function renameProject(project) {
  await withName("Rename project", project.name, async (name) => {
    if (name === project.name) return;
    await send("POST", `${projectUrl(project.id)}/rename`, { name });
    await refreshProjects();
  });
}

async function deleteProject(project) {
  const count = project.boards.length;
  const boards = count === 1 ? "its whiteboard" : `its ${count} whiteboards`;
  const question = `Delete the project "${project.name}"${count ? ` and ${boards}` : ""}? This cannot be undone.`;
  if (!(await askConfirm("Delete project", question, "Delete"))) return;
  const open = projectId === project.id;
  if (open) {
    clearTimeout(saveTimer);
    dirty = false;
  }
  try {
    await send("DELETE", projectUrl(project.id));
  } catch (err) {
    if (open) scheduleSave();
    showMessage("Delete failed", err.message);
    return;
  }
  if (open && projectId === project.id) closeBoard();
  await refreshProjects();
}

// Writes a new whiteboard into a project and opens it. Pending changes of the open one are sent first.
// overwrite replaces a whiteboard of the same name in the project (for Import).
async function createOnServer(project, newBoard, keepView = false, overwrite = false) {
  await saveNow();
  const { id } = await send("POST", `${projectUrl(project)}/boards${overwrite ? "?overwrite=true" : ""}`, newBoard);
  openBoard(newBoard, id, project, keepView);
  await refreshProjects();
}

async function createBoard(project) {
  if (!(await leaveBoard())) return;
  await withName(`New whiteboard in "${project.name}"`, "", (name) => createOnServer(project.id, ops.newBoard(name)));
}

async function openSaved(project, id) {
  if (id === boardId || !(await leaveBoard())) return;
  try {
    openBoard(ops.loadBoard(await api("GET", boardUrl(id))), id, project);
  } catch (err) {
    showMessage("Open failed", err.message);
    await refreshProjects();
  }
}

// The open whiteboard as it is on screen, or another one as it is saved.
async function boardData(id) {
  return id === boardId ? board : ops.loadBoard(await api("GET", boardUrl(id)));
}

// A copy of a whiteboard under a new name, in its own or another project; the copy opens.
async function saveBoardAs(project, id) {
  const source = await boardData(id);
  let name = source.name;
  let target = project;
  for (;;) {
    const input = textInput(name);
    const select = el("select", {}, ...projects.map((p) => el("option", { value: p.id }, p.name)));
    select.value = target;
    const result = await showDialog({
      title: "Save as",
      body: [el("label", {}, "Name"), input, el("label", {}, "Project"), select],
      collect: () => ({ name: input.value.trim(), project: select.value }),
    });
    if (!result) return;
    ({ name, project: target } = result);
    try {
      const copy = structuredClone(source);
      ops.renameBoard(copy, name);
      await createOnServer(target, copy, true);
      return;
    } catch (err) {
      await showMessage("Save as", err.message);
    }
  }
}

// Renames the open whiteboard on the server and in the page. Also used by the assistant.
async function renameOnServer(target, name) {
  name = ops.boardName(name);
  if (target !== board) throw new Error("This whiteboard is no longer open.");
  if (name === target.name) return;
  await send("POST", `${boardUrl(boardId)}/rename`, { name });
  ops.renameBoard(target, name);
  refreshProjects();
}

async function renameWhiteboard(id, current) {
  await withName("Rename whiteboard", current, async (name) => {
    if (id === boardId) {
      await renameOnServer(board, name);
      edits++;
    } else if (name !== current) {
      await send("POST", `${boardUrl(id)}/rename`, { name });
      await refreshProjects();
    }
  });
}

async function deleteWhiteboard(id, name) {
  if (!(await askConfirm("Delete whiteboard", `Delete the whiteboard "${name}"? This cannot be undone.`, "Delete"))) return;
  if (id === boardId) {
    clearTimeout(saveTimer);
    dirty = false;
  }
  try {
    await send("DELETE", boardUrl(id));
  } catch (err) {
    if (id === boardId) scheduleSave();
    showMessage("Delete failed", err.message);
    return;
  }
  if (id === boardId) closeBoard();
  await refreshProjects();
}

// On startup the last opened whiteboard opens again.
async function startUp() {
  const { last } = await refreshProjects();
  if (last) openBoard(ops.loadBoard(await api("GET", boardUrl(last.board))), last.board, last.project);
}

// ---------- Import and export ----------

let importProject = null; // the project an import goes into

async function importInto(project) {
  if (!(await leaveBoard())) return;
  importProject = project.id;
  $("file-load").click();
}

$("file-load").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  let data;
  try {
    data = ops.loadBoard(JSON.parse(await file.text()));
  } catch (err) {
    showMessage("Import failed", `Could not import ${file.name}: ${err.message}`);
    return;
  }
  await importData(data, importProject);
});

// The imported whiteboard keeps the name in its file. If that name is taken in the project, the user
// overwrites that whiteboard or imports under another name; a name that is not allowed is asked again.
async function importData(data, project) {
  const title = "Import whiteboard";
  let name = data.name;
  let overwrite = false;
  for (;;) {
    try {
      data.name = ops.boardName(name);
      await createOnServer(project, data, false, overwrite);
      return;
    } catch (err) {
      overwrite = false;
      if (err.status === 409) {
        const choice = await showDialog({
          title,
          message: `A whiteboard named "${name}" already exists in this project. Overwrite it, or import under another name?`,
          ok: "Overwrite",
          alt: "Rename",
        });
        if (choice === null) return;
        overwrite = choice === true;
        if (overwrite) continue;
      } else {
        await showMessage(title, err.message);
      }
      name = await askText(title, "Name", name);
      if (!name) return;
    }
  }
}

async function exportBoard(id) {
  const data = await boardData(id);
  const json = JSON.stringify(data, null, 2);
  const fileName = `${data.name}.json`;
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
      if (err.name !== "AbortError") showMessage("Export failed", `Could not export ${fileName}: ${err.message}`);
    }
    return;
  }
  // Firefox and Safari drop the download if the URL is revoked before it starts.
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = el("a", { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- Sidebar ----------

function toggleProject(id) {
  if (!expanded.delete(id)) expanded.add(id);
  renderSidebar();
}

// Buttons on a sidebar row; the click does not also open or toggle the row.
function rowButton(text, title, action) {
  return iconButton(text, title, (event) => {
    event.stopPropagation();
    action();
  });
}

function renderSidebar() {
  const rows = projects.map((project) => {
    const open = expanded.has(project.id);
    const head = el(
      "div",
      { class: "project-row" + (project.id === projectId ? " current" : ""), title: project.name, onclick: () => toggleProject(project.id) },
      el("span", { class: "twisty" }, open ? "▾" : "▸"),
      el("span", { class: "row-name" }, project.name),
      el(
        "span",
        { class: "row-actions" },
        rowButton("+", "New whiteboard", () => createBoard(project)),
        rowButton("⇧", "Import a whiteboard (JSON file)", () => importInto(project)),
        rowButton("✎", "Rename project", () => renameProject(project)),
        rowButton("×", "Delete project", () => deleteProject(project)),
      ),
    );
    if (!open) return el("div", { class: "project" }, head);
    const boards = project.boards.map((b) =>
      el(
        "div",
        { class: "board-row" + (b.id === boardId ? " open" : ""), title: b.name, onclick: () => openSaved(project.id, b.id) },
        el("span", { class: "row-name" }, b.name),
        el(
          "span",
          { class: "row-actions" },
          rowButton("⧉", "Save as (a copy, also into another project)", () => saveBoardAs(project.id, b.id)),
          rowButton("⇩", "Export (download as a JSON file)", () => exportBoard(b.id)),
          rowButton("✎", "Rename whiteboard", () => renameWhiteboard(b.id, b.name)),
          rowButton("×", "Delete whiteboard", () => deleteWhiteboard(b.id, b.name)),
        ),
      ),
    );
    if (!boards.length) boards.push(el("div", { class: "board-empty" }, "No whiteboards yet"));
    return el("div", { class: "project" }, head, ...boards);
  });
  if (!rows.length) rows.push(el("div", { class: "board-empty" }, "No projects yet"));
  $("project-list").replaceChildren(...rows);
}

$("sidebar-new").addEventListener("click", createProject);
$("sidebar-toggle").addEventListener("click", () => {
  const collapsed = $("sidebar").classList.toggle("collapsed");
  $("sidebar-toggle").textContent = collapsed ? "›" : "‹";
  $("sidebar-toggle").title = collapsed ? "Show projects" : "Hide projects";
});

// ---------- View: pan and zoom ----------

// The board has no edges: the view offset and the zoom are one transform on the content element.
function applyView() {
  const tx = -view.x * zoom;
  const ty = -view.y * zoom;
  content.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
  viewport.style.backgroundSize = `${GRID * zoom}px ${GRID * zoom}px`;
  viewport.style.backgroundPosition = `${tx}px ${ty}px`;
  $("btn-zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
}

function setView(x, y) {
  view = { x, y };
  applyView();
}

// Keeps the board point under (clientX, clientY), or under the viewport center, in place.
function setZoom(value, clientX, clientY) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
  const vr = viewport.getBoundingClientRect();
  const ax = clientX === undefined ? vr.width / 2 : clientX - vr.left;
  const ay = clientY === undefined ? vr.height / 2 : clientY - vr.top;
  view.x += ax / zoom - ax / next;
  view.y += ay / zoom - ay / next;
  zoom = next;
  applyView();
}

// Wheel scrolls up and down, Shift + wheel sideways, Ctrl + wheel zooms. Over the scrolling property
// list of a card with a fixed height, the wheel scrolls the list.
viewport.addEventListener(
  "wheel",
  (event) => {
    if (!board) return;
    if (event.ctrlKey) {
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
      return;
    }
    if (event.target.closest(".card.sized .properties")) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    let dx = event.deltaX * unit;
    let dy = event.deltaY * unit;
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
    setView(view.x + dx / zoom, view.y + dy / zoom);
  },
  { passive: false },
);

// Follows the pointer from a pointerdown until it is released. onMove(dx, dy, e) gets the distance from
// the start in screen pixels; onEnd(moved) runs on release.
function followPointer(event, onMove, onEnd) {
  event.preventDefault();
  const target = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  target.setPointerCapture(event.pointerId);
  const move = (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && !dx && !dy) return;
    moved = true;
    onMove(dx, dy, e);
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onEnd(moved);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

const onEmptySpace = (event) => !event.target.closest(".card, #links g");

// Right-drag pans, left-drag draws a selection rectangle, and a left click clears the selection or
// cancels link mode.
viewport.addEventListener("pointerdown", (event) => {
  if (!board || !onEmptySpace(event) || (event.button !== 0 && event.button !== 2)) return;
  // Taking the pointer stops the browser from moving focus, so save a link message being edited first.
  document.activeElement?.blur();
  if (event.button === 2) startPan(event);
  else if (linkSource) cancelLink();
  else startMarquee(event);
});

// On macOS, Ctrl + click (which toggles a card's selection) also fires contextmenu.
viewport.addEventListener("contextmenu", (event) => {
  if (board && (onEmptySpace(event) || event.target.closest(".card-header"))) event.preventDefault();
});

function startPan(event) {
  const start = { ...view };
  document.body.classList.add("panning");
  followPointer(
    event,
    (dx, dy) => setView(start.x - dx / zoom, start.y - dy / zoom),
    () => document.body.classList.remove("panning"),
  );
}

// ---------- Selection ----------

function startMarquee(event) {
  const box = $("marquee");
  const vr = viewport.getBoundingClientRect();
  let chosen = new Set();
  followPointer(
    event,
    (dx, dy) => {
      const left = Math.min(event.clientX, event.clientX + dx) - vr.left;
      const top = Math.min(event.clientY, event.clientY + dy) - vr.top;
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      box.hidden = false;
      const x1 = view.x + left / zoom;
      const y1 = view.y + top / zoom;
      const x2 = x1 + width / zoom;
      const y2 = y1 + height / zoom;
      chosen = new Set();
      for (const cardEl of cardsLayer.children) {
        const inside =
          cardEl.offsetLeft >= x1 &&
          cardEl.offsetTop >= y1 &&
          cardEl.offsetLeft + cardEl.offsetWidth <= x2 &&
          cardEl.offsetTop + cardEl.offsetHeight <= y2;
        if (inside) chosen.add(cardEl.dataset.id);
        cardEl.classList.toggle("selected", inside);
      }
    },
    (moved) => {
      box.hidden = true;
      if (moved) {
        selected = chosen;
        render();
      } else deselectAll();
    },
  );
}

function deselectAll() {
  selectedLinkId = null;
  selected.clear();
  render();
}

// Clears the selection without redrawing, so a card drag that has just started keeps going.
function clearSelection() {
  selected.clear();
  for (const cardEl of cardsLayer.querySelectorAll(".card.selected")) cardEl.classList.remove("selected");
}

// ---------- Cards ----------

async function addCard() {
  const { templates, error } = await loadTemplates();
  const values = await askNewCard(templates, error);
  if (!values) return;
  ops.addCard(board, { ...values, ...newCardPosition() });
  changed();
}

// The card templates from card_template.json, read again every time: { templates: { name: [tag] }, error }.
async function loadTemplates() {
  try {
    return await (await fetch("/api/templates")).json();
  } catch (err) {
    return { templates: {}, error: `Could not load the card templates: ${err.message}` };
  }
}

// Name, a template that starts at Empty, and for a chosen template one row per field: a checkbox (unchecked
// leaves the field out), the tag and the content, which may be blank. Resolves to { name, properties }.
function askNewCard(templates, error) {
  const name = textInput();
  const select = el(
    "select",
    {},
    el("option", { value: "" }, "Empty"),
    ...Object.keys(templates).map((template) => el("option", { value: template }, template)),
  );
  const rows = el("div", { class: "template-fields" });
  let fields = [];
  select.addEventListener("change", () => {
    fields = (templates[select.value] ?? []).map((tag) => {
      const check = el("input", { type: "checkbox", title: "Include this field" });
      check.checked = true;
      const input = textInput("", true);
      check.addEventListener("change", () => (input.disabled = !check.checked));
      return { tag, check, input };
    });
    rows.replaceChildren(...fields.flatMap(({ tag, check, input }) => [el("label", {}, check, tag), input]));
  });
  return showDialog({
    title: "New card",
    message: error ?? "",
    body: [el("label", {}, "Name"), name, el("label", {}, "Template"), select, rows],
    collect: () => ({
      name: name.value.trim(),
      properties: fields.filter((f) => f.check.checked).map((f) => ({ tag: f.tag, content: f.input.value.trim() })),
    }),
  });
}

// Near the top left of the visible area, shifted a little for each card so new cards do not stack exactly.
function newCardPosition() {
  const offset = (board.cards.length % 8) * 24;
  return { x: view.x + 40 + offset, y: view.y + 40 + offset };
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

// Moving or resizing a card: onMove(dx, dy) gets the distance in board coordinates.
function trackPointer(event, card, onMove) {
  dragging = true;
  let counted = false;
  followPointer(
    event,
    (dx, dy) => {
      if (!findCard(card.id)) return; // the assistant may have deleted the card
      if (!counted) edits++;
      counted = true;
      onMove(dx / zoom, dy / zoom);
      renderLinks();
    },
    () => {
      dragging = false;
      if (counted) scheduleSave();
      if (renderPending) render();
      else renderToolbar();
    },
  );
}

// Ctrl or Shift + click adds the card to the selection or removes it. Dragging a selected card moves
// every selected card; dragging another card clears the selection.
function startDrag(event, card, cardEl) {
  if (event.button !== 0 || event.target.closest("button") || linkSource) return;
  if (event.ctrlKey || event.shiftKey) {
    event.preventDefault();
    if (!selected.delete(card.id)) selected.add(card.id);
    cardEl.classList.toggle("selected", selected.has(card.id));
    return;
  }
  if (!selected.has(card.id)) clearSelection();
  const group = (selected.has(card.id) ? [...selected] : [card.id]).map((id) => {
    const { x, y } = findCard(id);
    return { id, x, y, el: id === card.id ? cardEl : cardsLayer.querySelector(`.card[data-id="${CSS.escape(id)}"]`) };
  });
  trackPointer(event, card, (dx, dy) => {
    for (const item of group) {
      const moving = findCard(item.id);
      if (!moving) continue;
      ops.moveCard(board, item.id, item.x + dx, item.y + dy);
      item.el.style.left = `${moving.x}px`;
      item.el.style.top = `${moving.y}px`;
    }
  });
}

function startResize(event, card, cardEl) {
  if (event.button !== 0 || linkSource) return;
  const origWidth = cardEl.offsetWidth;
  const origHeight = cardEl.offsetHeight;
  let fits = card.height === null;
  trackPointer(event, card, (dx, dy) => {
    // A card that fits its content keeps fitting until the drag moves vertically.
    fits &&= dy === 0;
    ops.resizeCard(board, card.id, origWidth + dx, fits ? null : origHeight + dy);
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
  const values = await askFields(title, [
    { label: "Tag", value: tag },
    { label: "Content", value: content, optional: true },
  ]);
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

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("dialog").open) return;
  if (linkSource) cancelLink();
  else if (selectedLinkId || selected.size) deselectAll();
});

// Unsent changes are sent at once; the browser asks before leaving while they are on their way.
window.addEventListener("beforeunload", (event) => {
  if (!dirty && !saving) return;
  saveNow();
  event.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveNow();
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
  $("search-toggle").textContent = collapsed ? "Search" : "\u2212";
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
        if (board === turnBoard) scheduleSave();
        render();
      },
      confirm: (question) => askConfirm("Assistant", question, "Allow"),
      cardPosition: newCardPosition,
      renameBoard: renameOnServer,
      stale: () => board !== turnBoard || edits !== start,
      model: $("chat-model").value,
      loadTemplates,
    });
  } catch (err) {
    error = err.message;
    if (err.unsent && !$("chat-input").value) $("chat-input").value = text;
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

function render() {
  // Rebuilding the cards would end a drag, so the board is redrawn when the drag ends.
  if (dragging) {
    renderPending = true;
    renderToolbar();
    renderChat();
    return;
  }
  renderPending = false;
  renderSidebar();
  if (linkSource && !ops.endpointExists(board, linkSource)) linkSource = null;
  for (const id of selected) if (!findCard(id)) selected.delete(id);
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
  $("board-name").textContent = board ? `${findProject(projectId)?.name ?? ""} / ${board.name}` : "";
  const failed = !!board && !!saveError;
  $("save-status").textContent = !board ? "" : failed ? "Save failed" : dirty || saving ? "Saving..." : "Saved";
  $("save-status").title = failed ? `${saveError} (retrying)` : "";
  $("save-status").classList.toggle("failed", failed);
  $("status").textContent = linkSource ? "Click a card or property to link to (Esc to cancel)" : "";
  $("empty-hint").hidden = !!board;
  $("empty-hint").textContent = projects.length
    ? "Open a whiteboard in the sidebar, or create one with + on a project."
    : "Create a project with + in the sidebar to begin.";
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
  if (selected.has(card.id)) cardEl.classList.add("selected");
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

// The board has no size, so the links layer is made to cover the cards, in board coordinates.
function sizeLinksLayer() {
  const cardEls = [...cardsLayer.children];
  const x1 = Math.min(0, ...cardEls.map((c) => c.offsetLeft)) - LINKS_MARGIN;
  const y1 = Math.min(0, ...cardEls.map((c) => c.offsetTop)) - LINKS_MARGIN;
  const x2 = Math.max(0, ...cardEls.map((c) => c.offsetLeft + c.offsetWidth)) + LINKS_MARGIN;
  const y2 = Math.max(0, ...cardEls.map((c) => c.offsetTop + c.offsetHeight)) + LINKS_MARGIN;
  Object.assign(linksLayer.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
  linksLayer.setAttribute("viewBox", `${x1} ${y1} ${x2 - x1} ${y2 - y1}`);
}

function renderLinks() {
  sizeLinksLayer();
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

$("btn-add-card").addEventListener("click", addCard);
$("btn-zoom-in").addEventListener("click", () => setZoom(zoom + 0.1));
$("btn-zoom-out").addEventListener("click", () => setZoom(zoom - 0.1));
$("btn-zoom-reset").addEventListener("click", () => setZoom(1));

applyView();
render();
startUp().catch((err) => showMessage("Open failed", `Could not load the projects: ${err.message}`));
