# Plan

Development phases for the first version. The design is in `README.md`. Each phase ends with a manual check in the browser (`uv run detective-whiteboard`).

## Tooling

- No third-party dependencies. Backend uses the standard library; frontend is plain HTML, CSS and JavaScript.
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
- [ ] Check the save dialog by hand in a real browser (it needs a user gesture).

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
