# Plan

Development phases for the first version. The design is in `README.md`. Each phase ends with a manual check in the browser (`uv run detective-whiteboard`).

## Tooling

- Backend uses the standard library plus `python-dotenv` and `certifi`; frontend is plain HTML, CSS and JavaScript.
- Testing is manual in the browser, plus `node --check src/detective_whiteboard/static/app.js` as a syntax check when Node is available. No test framework for now.

## Phase 1: Server and page skeleton

- [x] `main()` serves `static/` on `127.0.0.1:8000` by default (`--host`, `--port`) with `http.server` and opens the browser.
- [x] `index.html` with toolbar (Create, Load, Save, Rename, Create Card, zoom out / reset / in) and board viewport.
- [x] `board` state, `render()`, buttons disabled until a board is open.
- [x] Create, Rename, Save (`showSaveFilePicker` or download), Load (file dialog), unsaved-changes confirmation.
- [x] Zoom buttons and Ctrl + wheel, 25% to 200%.

## Phase 2: Cards

- [x] Create card in the visible area, rename, delete (with attached links).
- [x] Drag by header, with zoom-aware coordinates.
- [x] Update picture: PNG/JPG, scaled on a canvas to card width, stored as data URL.

## Phase 3: Properties

- [x] Add (tag and content), edit (keeps ID), delete (with attached links).
- [x] Up and down buttons swap neighbors.

## Phase 4: Links

- [x] Link mode from card or property link buttons, target click creates link, Escape or own card cancels.
- [x] SVG layer with arrow markers, card border anchors, property row side anchors, wide hit line.
- [x] Selection panel: color, style, direction, delete. Click on empty board deselects.

## Phase 5: Polish

- [x] Update `CLAUDE.md` "Current State and Commands".
- [x] End-to-end check in headless Chrome: create, cards, pictures, properties, reorder, links, link editing, zoom, load round trip, card deletion.
- [x] Simulated mouse input in headless Chrome: dragging at 100% and 50% zoom, Ctrl + wheel zoom, link selection and deselection.
- [x] Check the save dialog by hand in a real browser (it needs a user gesture).

## Phase 6: Loose ends

- [x] Fix stale docs: Phase 1 port note, `pyproject.toml` description.
- [x] Board grows to fit cards dragged past the right or bottom edge (minimum 4000 x 3000).
- [x] Load drops links whose card or property does not exist, instead of failing to render.

## Phase 7: In-page dialogs

- [x] One `<dialog>` in `index.html`, styled like the cards, with a title, optional message, labeled text fields, and OK / Cancel buttons. Enter confirms, Escape cancels, blank fields are rejected.
- [x] `showDialog()` in `app.js` returns a promise; `prompt()`, `confirm()` and `alert()` are replaced by it. Property add and edit ask for Tag and Content in one dialog.
- [x] Escape in the dialog does not also cancel link mode or deselect a link.
- [x] Update `README.md`.

## Phase 8: Review fixes

- [x] Load checks for `name`, `cards` and `links` and filters links before replacing the current board, so a bad file leaves the open board untouched.
- [x] Clicking a link while in link mode leaves link mode before selecting the link.
- [x] Deleting a property asks for confirmation.
- [x] Dragging also ends on `pointercancel`.
- [x] Card and property IDs are escaped with `CSS.escape` in selectors.
- [x] Save shows an error and keeps the unsaved marker if writing the file fails.
- [x] Update `README.md`.

## Phase 9: Search

- [x] Search box in the top right corner of the whiteboard, with a button that minimizes it to a small "Search" button and restores it. The link panel stacks below it.
- [x] Keyword search, case-insensitive, matching anywhere in the text. `*` matches any run of characters and `?` one character; all other characters are literal.
- [x] Cards whose name matches and properties whose `Tag: Content` text matches are highlighted in light yellow. A match count is shown, also while minimized.
- [x] Highlights follow edits, since they are applied in `render()`. The search is a view setting and is not saved.
- [x] Update `README.md`.

## Phase 10: Search modes

- [x] Three tabs in the search box: Global, Card and Property. Global and Card share the keyword field; Property has Tag and Content fields. Minimizing hides tabs and fields.
- [x] Global: card names and `Tag: Content` text of properties (as in Phase 9).
- [x] Card: card names only.
- [x] Property: properties whose tag equals the Tag field (case-insensitive, no wildcards) and whose content matches the Content field (wildcards, anywhere in the text). An empty Content field matches every property with that tag; an empty Tag field matches nothing.
- [x] Update `README.md`.

## Phase 11: Operations layer

Prepare for an AI assistant whose tools call the same operations as the user interface.

- [x] New `static/ops.js` with one `ops` object of plain functions on a board object. No DOM access, JSON-friendly arguments and results, cards, properties and links referenced by ID. Bad input (unknown ID, blank text, invalid color, style or direction, link within one card) throws an `Error` with a readable message.
  - Whiteboard: `newBoard`, `loadBoard`, `renameBoard`.
  - Cards: `addCard`, `renameCard`, `moveCard`, `setCardPicture`, `deleteCard`.
  - Properties: `addProperty`, `editProperty`, `moveProperty`, `deleteProperty`.
  - Links: `addLink`, `updateLink`, `deleteLink`.
  - Search: `search` (global, card and property modes).
- [x] `app.js` keeps dialogs, file handling, dragging, zoom and rendering, and makes every change through `ops`.
- [x] Check the operations with a short Node script and the UI in headless Chrome.
- [x] Update `README.md` and `CLAUDE.md`.

## Phase 12: AI assistant

Phase 15 later moved the assistant from Chat Completions to the Responses API.

The assistant is an OpenAI model with the board operations as tools. The board lives in the browser, so the browser runs the chat loop and executes the tools; the server only adds the API key and forwards requests, so the key never reaches the browser.

- [x] `.env` holds `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (default `gpt-6-luna`); loaded with `python-dotenv`. `.env` is ignored by git.
- [x] Server: `POST /api/chat` forwards `messages` and `tools` to the Chat Completions API and returns the response or a readable error (missing key, OpenAI error, network error).
- [x] `static/assistant.js`: tool definitions over `ops` (rename whiteboard; add, rename, move and delete cards; add, edit, move and delete properties; add, update and delete links; search), a system prompt with the current board (pictures left out), and the loop that calls the server and runs tools until the model answers. Tool errors are returned to the model. Deletes ask the user for confirmation first.
- [x] The chat is part of the board: `chat` in the JSON file holds the messages in Chat Completions format. Older files without `chat` load with an empty chat. Chat changes mark the board as unsaved.
- [x] Chat panel in the bottom right corner, opened and closed with an Assistant toolbar button: messages, a short line per tool action, a text box (Enter sends, Shift+Enter for a new line), Send, and Clear (with confirmation). Create and Load are disabled while the assistant is working.
- [x] Check the tool loop with a stubbed model in headless Chrome and the server with a fake OpenAI endpoint.
- [x] Check by hand with a real key (gpt-6-luna and gpt-6.2-astra).
- [x] Update `README.md` and `CLAUDE.md`.

## Phase 13: Model choice

- [x] Server: `MODELS` lists the selectable models (`gpt-6-luna`, `gpt-6.2-astra`). The default is `OPENAI_MODEL` or `gpt-6-luna`, and is added to the list if missing. `GET /api/models` returns the list and the default; `POST /api/chat` takes an optional `model` and rejects models not in the list.
- [x] Chat panel: a model dropdown in its header, filled from `/api/models` with the default selected. The choice is a view setting and is not saved in the file.
- [x] Update `README.md`.
- [x] Each model in `MODELS` has its own `reasoning_effort` (`none` for `gpt-6-luna`, left out for `gpt-6.2-astra`, which rejects `none`), replacing the global `OPENAI_REASONING_EFFORT`.

## Phase 14: Always-visible chat panel

- [x] Remove the Assistant toolbar button. The chat panel is always in the bottom right corner, like the search box, with a button that minimizes it to its header and restores it.
- [x] Without an open board the panel stays visible with its text box, Send, Clear and model choice disabled.
- [x] Update `README.md`.

## Phase 15: Responses API

`gpt-6.2-astra` rejects function tools in Chat Completions both with reasoning (`reasoning_effort` other than `none`) and without it (`none` is not accepted), so the assistant moves to the Responses API.

- [x] Server: `POST /api/chat` takes `model`, `instructions`, `input` and `tools` and calls `/v1/responses` with `store: false` (nothing is kept at OpenAI; the whiteboard file holds the chat) and encrypted reasoning included, plus `reasoning.effort` from `MODELS` when set.
- [x] `assistant.js`: tools in Responses format; the system prompt goes in `instructions`; `board.chat` holds Responses items (user messages, reasoning, assistant messages, function calls and their outputs), with output items stored exactly as returned so reasoning carries over between steps.
- [x] Chat panel reads the new item types; reasoning items are not shown.
- [x] Re-run the stubbed tool loop and server tests; update `README.md`.

## Phase 16: Working alongside the assistant

The user keeps working while the assistant waits for the model. Each request already sends a snapshot of the current whiteboard (JSON, pictures left out) in the instructions.

- [x] `app.js` counts user edits (every UI change through `ops`, a card drag, Create and Load). `assistant.send` gets a `stale()` hook that is true once the count changed or the board was replaced since the message was sent.
- [x] When stale, write tools (everything except `search`) return a "blocked" error to the model without changing the board, so the model can still answer. The turn ends with a notice item in `board.chat`, shown in the chat and left out of requests to the model.
- [x] Create and Load stay enabled while the assistant works; the chat input is disabled until the turn ends. Output of a turn for a replaced board does not touch the new board.
- [x] Concurrency safety: dialogs queue instead of overwriting an open one; a render during a card drag is deferred to the drag's end; link mode ends when its source is deleted; errors from UI actions on deleted items are shown in a dialog.
- [x] Check the tool loop with a stubbed model in Node, and the UI in headless Chrome.
- [x] Update `README.md`.

## Phase 17: Link messages and card resizing

- [x] Links get a `message` (default empty). `ops.addLink` and `ops.updateLink` accept it (trimmed; empty removes it). Loading fills it in for older files.
- [x] Link panel: a Message field below Color, Style and Direction, saved on Enter or when it loses focus. A non-empty message is drawn at the middle of the line in the link's color, and clicking it selects the link.
- [x] Cards get `width` (default 220) and `height` (`null` fits the content). `ops.resizeCard(board, cardId, width, height)` with a minimum of 160 x 80. Loading fills in the defaults.
- [x] A handle in the bottom right corner of each card resizes it by dragging; double-clicking it returns the height to fit the content. A card with a fixed height scrolls its property list, and its picture shrinks to fit.
- [x] Pictures are stored up to 480 wide (was 220) so they stay sharp on wider cards.
- [x] Assistant: `message` on `add_link` and `update_link`, a `resize_card` tool, and card sizes in the board snapshot.
- [x] Check in headless Chrome: message editing and display, resizing, fit content, links following resized cards, save and load.
- [x] Update `README.md` and `CLAUDE.md`.

## Phase 18: Link search

- [x] `ops.search` gets a `link` mode (keyword against link messages) and Global also matches link messages. Results include `links: [linkId]`.
- [x] A Link tab in the search box, sharing the keyword field with Global and Card. Matching links get a yellow halo along the line and a yellow message box, and count towards the number of matches.
- [x] The assistant's `search` tool describes the new mode and returns link IDs.
- [x] Check in headless Chrome; update `README.md`.

## Phase 19: Stale browser cache

The server sent no `Cache-Control` header, so browsers could keep using an old `index.html`, `app.js` and `style.css` after an update (no resize handle, no message field).

- [x] Every response carries `Cache-Control: no-cache`, so the browser revalidates each file (a cheap 304 when unchanged).
- [x] The search box and link panel sit above the chat panel; on short windows the chat panel covered the link panel.

## Phase 20: Infinite board, panning and multi-select

Branch `infinite-board`.

- [x] Infinite board: no scrollbars and no edges. The view is an offset plus the zoom, applied as one CSS transform on the content element. Card positions may be negative (`ops` no longer clamps them to 0). The links layer is sized to the cards' bounds instead of the board growing.
- [x] Mouse wheel scrolls up and down, Shift + wheel sideways, Ctrl + wheel zooms at the cursor. A dot grid moves with the board so panning is visible on empty space.
- [x] Right-drag on empty board space pans; the point under the cursor stays under it. The browser menu is suppressed on empty space. Cards and links do not start a pan.
- [x] New boards start at the origin; a loaded board starts with its top-left card in view. The view is not saved.
- [x] Left-drag on empty space draws a selection rectangle; cards fully inside it are selected (replacing the previous selection). Links are not selected.
- [x] Ctrl or Shift + click on a card header adds the card to the selection or removes it.
- [x] Dragging the header of a selected card moves all selected cards. Dragging an unselected card clears the selection and moves that card.
- [x] Clicking empty space or Escape clears the selection. The selection is a view setting and is not saved.
- [x] Assistant system prompt says positions may be negative.
- [x] Check in headless Chrome; update `README.md` and `CLAUDE.md`.

## Phase 21: Card templates

Branch `card-templates`.

- [x] `card_template.json` in the project folder maps template names to field tags, in order: `{"Person": ["Age", "Career"], ...}`. An example file is committed.
- [x] Server: `GET /api/templates` reads the file on every request (found like `.env`) and returns `{templates}`, or `{templates: {}, error}` when it is broken. A missing file gives no templates.
- [x] Properties may have empty content everywhere (`ops.addProperty`, `ops.editProperty`, the property dialog, the assistant). Tags stay required.
- [x] `ops.addCard` takes an optional `properties` list of `{tag, content}`.
- [x] Create Card dialog: Name, a Template dropdown starting at Empty, and for a chosen template one row per field with a checkbox (checked by default), the tag and a content input. Checked fields become properties, blank ones with empty content. A broken file shows its error in the dialog.
- [x] Assistant: each turn loads the templates into the system prompt. `add_card` takes `template`, `contents` (tag to content; others stay empty) and `skip` (tags to leave out).
- [x] Check in headless Chrome; update `README.md` and `CLAUDE.md`.

## Phase 22: Review fixes

Branch `review-fixes-2`.

- [x] Save clears the unsaved marker only if the board did not change while the file was written. The download fallback revokes its URL after a delay, so Firefox and Safari keep the file.
- [x] Server: `POST /api/chat` requires `Content-Type: application/json` and, when an `Origin` header is sent, one matching `Host`, so other web pages cannot use the API key. Bad requests and non-JSON replies from OpenAI get a readable error instead of a dropped connection.
- [x] Assistant: if a turn fails before the model answers, the user's message is taken out of the chat and put back in the text box.
- [x] Widening a card that fits its content keeps it fitting; the height is fixed only once the drag moves vertically.
- [x] Load fills in missing `properties` and rejects cards whose position is not a number.
- [x] Ctrl + click on a card header does not open the context menu on macOS.
- [x] Check with `node --check`, a short server test and headless Chrome; update `README.md`.

## Phase 23: Certificates

Branch `review-fixes-2`. Python from python.org has no CA certificates until its installer script is run, so requests to OpenAI failed with `CERTIFICATE_VERIFY_FAILED`.

- [x] Add `certifi`; the server verifies OpenAI's certificate against its CA bundle.
- [x] Check with the real app (`uv run detective-whiteboard`) and a luna turn; update `README.md`.

## Phase 24: Chat request check

Branch `fix-chat-request`. A JSON request to `/api/chat` without `instructions`, `input` or `tools` raised a `KeyError` and dropped the connection.

- [x] Server: reject a body that is not a JSON object or lacks those fields with a 400 and a readable error.
- [x] Note in Phase 12 that Phase 15 replaced Chat Completions with the Responses API.
- [x] Check with a short server test.

## Phase 25: Server storage

Branch `server-storage`. The server keeps the whiteboards in `./data` (the folder the app is started in), one `<name>.json` each, and the browser saves every change automatically. Files on the user's computer become import and export only. The file layout is temporary (boards may later move to MongoDB and links to SQLite), so the last opened whiteboard is kept in its own file, `data/last_whiteboard.txt`, instead of being derived from timestamps.

- [x] Whiteboard names must not contain `/ \ : * ? " < > |` (checked in `ops` and on the server).
- [x] Server API (writes need JSON and a matching `Origin`, like `/api/chat`):
  - `GET /api/boards` lists the names and the last whiteboard; `GET /api/boards/<name>` reads one.
  - `POST /api/boards/<name>` creates (409 if it exists); `PUT /api/boards/<name>` saves; `DELETE /api/boards/<name>` deletes.
  - `POST /api/rename` `{from, to}` renames the file and the name inside it.
  - `PUT /api/last` `{name}` sets the last whiteboard; rename follows it and delete clears it.
  - Files are written to a temporary file and moved into place, so a crash never leaves half a file.
- [x] Browser: auto-save about one second after the last change (card drags and assistant changes included), and at once when switching whiteboards or leaving the page. Server requests run one after another. The toolbar shows Saving..., Saved or Save failed (retried every few seconds).
- [x] Toolbar: Create, Open (list of saved whiteboards), Save As, Rename, Delete, Import, Export. Save is gone.
  - Create and Save As refuse existing names and ask again. Save As continues on the copy.
  - Rename (also the assistant's tool) renames the file.
  - Delete asks for confirmation, then closes the whiteboard.
  - Import uses the name in the file; for an existing name the user chooses Overwrite or Rename.
  - Export downloads the JSON file as Save did.
- [x] On startup the last whiteboard opens.
- [x] `data/` is ignored by git.
- [x] Check the server API with a short script and the UI in headless Chrome; update `README.md` and `CLAUDE.md`.

## Phase 26: MongoDB storage

Branch `mongodb-storage`. The whiteboards move from JSON files to MongoDB, run by the app in a Podman container. The user sees no difference: the HTTP API and the browser stay as they are. The layout prepares for projects and users: for now there is one hard-coded user, `default-user`, with one project, `Default`.

- [x] Container (`container.py`): `uv run detective-whiteboard` starts `docker.io/library/mongo:8.0` as `detective-whiteboard-mongo-<port>` and stops it on exit (`--rm`, so every start is a fresh container on the same data). A running container of that name is reused, but only if it uses the same data folder.
  - Data in `data/mongo` (bind mount with `:Z` for SELinux, `--userns=keep-id` so the files belong to the user, `--image-volume=ignore`).
  - Port `127.0.0.1:27018` (option `--db-port`), no authentication for now.
  - Single-node replica set `rs0`, initiated on first start, for transactions; the client connects with `directConnection=true`.
- [x] Storage (`storage.py`), database `detective_whiteboard`:
  - `users` `{_id, name}`; `projects` `{_id, name, owner, members}`; `app_state` `{_id: user, last_whiteboard}`.
  - `whiteboards` `{_id, project_id, name, version, chat}`, unique by project and name.
  - `cards` `{whiteboard_id, id, order, name, x, y, width, height, picture, properties}`, unique by whiteboard and card ID.
  - `links` `{whiteboard_id, id, order, source, target, color, style, direction, message}`, unique by whiteboard and link ID, indexed by the card at each end.
  - A save updates the whiteboard, upserts its cards and links and deletes the missing ones in one transaction. The current user and project come from one function each.
- [x] Server: the `/api/boards`, `/api/rename` and `/api/last` endpoints use the storage functions. Name rules unchanged. `card_template.json` is read as UTF-8.
- [x] Stopping the app with SIGTERM or SIGHUP (closing the terminal, `kill`) also stops MongoDB. A failed start never stops a container that belongs to another app.
- [x] Remove the test JSON files from `data/`.
- [x] Check the API and the UI in headless Chrome against a separate test port; update `README.md` and `CLAUDE.md`.
