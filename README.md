# Detective Whiteboard

A browser-based whiteboard for organizing a case: cards with pictures and properties, connected by links. The requirements are listed in `CLAUDE.md`; this document describes the design.

## Running

```
uv run detective-whiteboard
```

This starts MongoDB in a Podman container, then a local web server on `http://127.0.0.1:8000/`, and opens the whiteboard in the default browser. Stopping the app (Ctrl+C, closing the terminal or `kill`) stops MongoDB too. The whiteboards are stored in MongoDB, whose files are in `data/mongo/` in the folder the app is started in (ignored by git). Podman must be installed; the first start downloads the MongoDB image. See Storage.

The AI assistant needs an OpenAI API key in a `.env` file in the project folder (ignored by git):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-6-luna
```

The chat panel offers `gpt-6-luna` and `gpt-6.2-astra` (`MODELS` in `__init__.py`). `OPENAI_MODEL` is optional and sets the default model, `gpt-6-luna` if unset; a model not in the list is added to it. `MODELS` also sets the reasoning effort sent with each model: `none` for `gpt-6-luna`, and nothing for `gpt-6.2-astra`, which then uses its own default (it does not accept `none`). A model added through `OPENAI_MODEL` gets no reasoning effort. Without a key the rest of the app works and the assistant reports the missing key.

Options:

- `--port N` sets the port (default 8000).
- `--db-port N` sets the local port of MongoDB (default 27018, so it does not clash with a MongoDB installed on the machine).
- `--host 0.0.0.0` allows access from other machines on the LAN at `http://<server IP>:<port>/`. The port may need to be opened in the firewall (for example `sudo firewall-cmd --add-port=8000/tcp`). There is no authentication, and anyone who can reach the server can read, change and delete every whiteboard and use the assistant with your API key. Other web pages open in the browser cannot: the API only accepts changes as JSON requests whose `Origin`, when sent, matches the server. Browsers only offer the save dialog on `localhost` or HTTPS, so on a LAN address Export downloads the file instead.

## Architecture

The application is a single-page web app served by a minimal Python server.

- Backend: `src/detective_whiteboard/__init__.py`, with `container.py` (the MongoDB container) and `storage.py` (whiteboards in MongoDB). `main()` loads `.env` (`python-dotenv`), starts MongoDB, serves the `static/` directory (on `127.0.0.1` by default, with `Cache-Control: no-cache` so the browser picks up updated files) using the standard library `http.server` and opens the browser. `GET /api/models` returns the selectable models and the default. `GET /api/templates` reads `card_template.json` (see Card Templates) on every request and returns `{"templates": {...}}`, with an `error` and no templates when the file is broken. `POST /api/chat` forwards `instructions`, `input` and `tools` to the OpenAI Responses API with the API key added, using the requested `model` (which must be in the list) or the default, so the key never reaches the browser. It accepts only `Content-Type: application/json` and rejects requests whose `Origin` does not match the `Host`, so other web pages cannot use the key. OpenAI's certificate is checked against the CA bundle from `certifi`, since Python from python.org has none of its own. It sets `store: false`, so nothing is kept at OpenAI, and asks for encrypted reasoning, which the browser sends back with the next request. Errors come back as `{"error": {"message": ...}}`. The storage endpoints are listed under Storage.
- Frontend: `src/detective_whiteboard/static/` with `index.html`, `style.css`, `ops.js`, `assistant.js` and `app.js`. Plain HTML, CSS and JavaScript, with no framework or build step.

The server stores the whiteboards (see Storage). The open whiteboard is held in the browser, which sends it to the server after every change; the browser also runs the assistant's chat loop and its tools. A future database backend would change the storage functions in the server without changing the data model or the API.

### Frontend structure

- State: one `board` object that matches the JSON file format below.
- Operations (`ops.js`): every change to a board is a function of the `ops` object, so the user interface and a future AI assistant share the same code. The functions only change the board data and never touch the page. They take the board and JSON-friendly arguments, refer to cards, properties and links by ID, and return the new card, property or link where there is one. Bad input (unknown ID, blank text, invalid color, style or direction, a link within one card) throws an `Error` with a readable message.
  - Whiteboard: `boardName(name)` (checks a name), `newBoard(name)`, `loadBoard(data)`, `renameBoard(board, name)`. A whiteboard name must not be blank or contain `/ \ : * ? " < > |`, since it is also the file name.
  - Cards: `addCard(board, {name, x, y, properties})` (`properties` is an optional list of `{tag, content}`), `renameCard(board, cardId, name)`, `moveCard(board, cardId, x, y)`, `resizeCard(board, cardId, width, height)` (`height` `null` fits the content), `setCardPicture(board, cardId, dataUrl)`, `deleteCard(board, cardId)`.
  - Properties: `addProperty(board, cardId, {tag, content})`, `editProperty(board, cardId, propertyId, {tag, content})` (either field may be left out; content may be empty), `moveProperty(board, cardId, propertyId, position)` (0 is the top), `deleteProperty(board, cardId, propertyId)`.
  - Links: `addLink(board, source, target, {color, style, direction, message})`, `updateLink(board, linkId, {color, style, direction, message})`, `deleteLink(board, linkId)`. An endpoint is `{card}` or `{card, property}`. A color is a name from `ops.COLORS` or `#rrggbb`. Deleting a card or property also deletes its links.
  - Search: `search(board, {mode, keyword, tag, content})` returns `{cards: [cardId], properties: [{card, property}], links: [linkId]}`.
- Assistant (`assistant.js`): one tool per operation (except creating, loading, pictures and chat), a system prompt with the current board (pictures left out), and `assistant.send(board, text, hooks)`, which calls `/api/chat` and runs tool calls until the model answers in text. A tool error is returned to the model as `{"error": ...}`. Every tool except `search` changes the board and is blocked once `hooks.stale()` reports that the user changed the board during the turn. It does not touch the page; `hooks` let the user interface redraw, confirm deletes, place new cards, rename the whiteboard on the server and report user edits.
- User interface (`app.js`): dialogs, storage requests, import and export, dragging, zoom and rendering. Every user action makes its change through `ops` and then calls `changed()`, which schedules a save and calls `render()`.
- Rendering: `render()` rebuilds the board from `board`. Cards are absolutely positioned `div` elements inside a board content element, which sits in a viewport without scrollbars. Links are drawn on an SVG layer inside the same content element, so cards and links share one coordinate system. The board has no edges: card positions may be negative, and the SVG layer is sized to cover the cards.
- View: `view` is the board point at the top left of the viewport. One CSS transform on the content element, `translate(-view * zoom) scale(zoom)`, pans and zooms cards and links together, and the background dot grid is shifted and scaled to match. Pointer distances are divided by `zoom` to convert them to board coordinates.
- Dragging: the card header is the drag handle. Pointer events update the card's `x` and `y` (of every selected card when the dragged card is selected), and links are redrawn while the cards move.
- Dialogs: one in-page `<dialog>`, styled like the cards, is used for all input, confirmations and error messages. A dialog requested while another is open waits until that one closes. `showDialog()` fills in a title, an optional message and a body of labels and inputs, and returns a promise with the result of its `collect()` function, or `null` on Cancel. An optional third button (`alt`) resolves to `"alt"`. `askFields()` builds it from labeled text fields and returns the trimmed values. Enter confirms, Escape cancels, and blank fields are rejected unless they are optional. The browser's own prompt is used only for the leave-page warning.

## Card Templates

`card_template.json` in the project folder (found like `.env`, from the folder the app is started in or a parent) lists the card templates, each a name and its field tags in order:

```json
{
  "Person": ["Age", "Career"],
  "Place": ["Location"],
  "Object": ["Owner"]
}
```

The file is read again every time a card is created and at the start of each assistant turn, so edits apply without a restart. Without the file there are no templates. The assistant sees the templates in its system prompt, and its `add_card` tool takes `template`, `contents` (content by tag; other fields stay empty) and `skip` (tags to leave out).

## Storage

The whiteboards are stored in MongoDB, which the app runs in a Podman container (`container.py`):

- Image `docker.io/library/mongo:8.0`, container `detective-whiteboard-mongo-<db port>`. Every start runs a new container (`--rm`) on the same data, and stopping the app stops it. A container of that name that is still running (for example after a crash) is reused if it uses the same data folder; otherwise the app refuses to start.
- The data folder `data/mongo` is mounted with `:Z` for SELinux and `--userns=keep-id`, so the files belong to the user. MongoDB listens on `127.0.0.1:<db port>` only and has no authentication for now; only the app uses it.
- MongoDB runs as a single-node replica set (`rs0`, set up on the first start), which it needs for transactions. The client connects with `directConnection=true`.
- To back up the data, stop the app and copy `data/mongo`, or export the whiteboards.

Database `detective_whiteboard` (`storage.py`). It is laid out for users, who are not in the app yet: for now every request comes from the user `default-user`, created on start, and `Storage.current_user()` is the only place that says so. A user sees the projects they own or are a member of. A new database has no projects.

- `users`: `{_id, name}`.
- `projects`: `{_id, name, owner, members}`, unique by owner and name; sharing will add user IDs to `members`.
- `app_state`: `{_id: user, last_whiteboard}`, the ID of each user's last opened whiteboard.
- `whiteboards`: `{_id, project_id, name, version, chat}`, unique by project and name.
- `cards`: the cards of the file format plus `whiteboard_id` and `order` (their position in the list), unique by whiteboard and card ID.
- `links`: the links of the file format plus `whiteboard_id` and `order`, unique by whiteboard and link ID, and indexed by the card at each end.

The browser still sends the whole whiteboard with every save. A save replaces the whiteboard's cards and links and deletes the ones that are gone, all in one transaction.

The API refers to projects and whiteboards by ID, so a rename never breaks a request on its way:

- `GET /api/projects`: `{"projects": [{"id", "name", "boards": [{"id", "name"}]}], "last": {"project", "board"} or null}`, sorted by name.
- `POST /api/projects` with `{"name"}`: creates a project, returns `{"id"}`; 409 if the name is taken.
- `POST /api/projects/<id>/rename` with `{"name"}`; `DELETE /api/projects/<id>` deletes it with its whiteboards, cards and links in one transaction.
- `POST /api/projects/<id>/boards`: creates a whiteboard from its JSON, returns `{"id"}`; 409 if the name is taken in the project. With `?overwrite=true` a whiteboard of that name is replaced instead (Import).
- `GET /api/boards/<id>`: the whiteboard JSON. `PUT /api/boards/<id>`: saves it; the name in the body is ignored, and a deleted whiteboard is not brought back (404). `DELETE /api/boards/<id>` deletes it.
- `POST /api/boards/<id>/rename` with `{"name"}`; 409 if the name is taken in the project.
- `PUT /api/last` with `{"board"}`: sets the last whiteboard. Deleting a whiteboard clears it where it was the last one.

Project and whiteboard names follow the same rules. Names are checked on the server too (400 when not allowed); the rules come from when whiteboards were files and still fit Export, which uses the name as the file name. Requests that change anything need `Content-Type: application/json` (except DELETE) and a matching `Origin`, as for `/api/chat`. With several tabs on one whiteboard the last save wins.

## Data Model and File Format

A whiteboard is imported and exported as one self-contained JSON file named `<whiteboard name>.json`. The API sends and receives whiteboards in the same format.

```json
{
  "version": 1,
  "name": "The Case",
  "cards": [
    {
      "id": "c1",
      "name": "Suspect A",
      "x": 120,
      "y": 80,
      "width": 220,
      "height": null,
      "picture": "data:image/jpeg;base64,...",
      "properties": [
        { "id": "p1", "tag": "Age", "content": "42" }
      ]
    }
  ],
  "links": [
    {
      "id": "l1",
      "source": { "card": "c1", "property": "p1" },
      "target": { "card": "c2", "property": null },
      "color": "#000000",
      "style": "solid",
      "direction": "forward",
      "message": "Paid him 5000"
    }
  ],
  "chat": [
    { "role": "user", "content": "Link Suspect A to Suspect B" },
    { "type": "reasoning", "encrypted_content": "...", ... },
    { "type": "function_call", "call_id": "call_1", "name": "add_link", "arguments": "{...}", ... },
    { "type": "function_call_output", "call_id": "call_1", "output": "{...}" },
    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Done." }], ... },
    { "type": "notice", "text": "The whiteboard was changed while the assistant was working, ..." }
  ]
}
```

- `width` is the card width, at least 160. `height` is `null` to fit the content, or at least 80. Files without them load with width 220 and fitting height.
- `picture` is a data URL or `null`. Embedding the image keeps the file self-contained.
- The order of `properties` is the display order. New properties are appended, and the up and down buttons swap neighbors.
- A link endpoint is a card (`property: null`) or a property of a card.
- `style` is `solid`, `dashed` or `dotted`.
- `direction` is `forward` (source to target), `backward` (target to source) or `none`.
- `message` is text shown on the line, or empty. Files without it load with an empty message.
- `chat` is the assistant's chat history as Responses API input items: user messages, and the model's output items (reasoning, messages, function calls) stored exactly as returned, followed by the result of each function call. A `notice` item marks a turn whose changes were blocked; it is shown in the chat but not sent to the model. Files without `chat` load with an empty chat.
- IDs are unique strings generated by the frontend and are only used for references inside the file.

## Behavior

### Projects and whiteboards

- The sidebar on the left lists the projects, each with its whiteboards nested under it, sorted by name. Clicking a project expands or collapses it; clicking a whiteboard opens it. The open whiteboard is highlighted and its project name shown in blue. The `<` button collapses the sidebar to a narrow strip, and `>` brings it back.
- Project names are unique, and whiteboard names are unique within a project; both follow the same rules. A name that is taken or not allowed is reported and asked again.
- Sidebar header: + creates a project.
- Project row (buttons on hover): + creates a whiteboard in the project and opens it, the arrow imports one into the project, the pencil renames the project, and x deletes it with all its whiteboards after a confirmation that says how many go with it.
- Whiteboard row (buttons on hover): the pencil renames it, x deletes it after a confirmation. Deleting the open whiteboard closes it.
- The toolbar shows `project / whiteboard` and acts on the open whiteboard: Save As, Rename, Delete and Export.
- Without projects the board asks for one to be created; with projects but no open whiteboard it points to the sidebar.
- Auto-save: the open whiteboard is saved about one second after the last change (card drags, resizes and the assistant's changes included), and at once before another whiteboard is opened and when the page is hidden or left. Leaving the page while changes are on their way asks for confirmation. Next to the whiteboard name the toolbar shows Saving..., Saved or Save failed (with the reason as a tooltip); a failed save is retried every five seconds. If the latest changes could not be saved, opening another whiteboard asks first.
- On startup the last opened whiteboard (the one last created, opened, imported or saved as) opens again, with its project expanded.
- Save As: asks for a new name, pre-filled with the current one, and a project, the current one by default. It saves a copy there and continues on the copy with the same view, so it also copies a whiteboard into another project.
- Import: opens a file dialog for `.json` files and adds the whiteboard to that project under the name inside the file, then opens it. If that name is taken in the project, a dialog offers Overwrite (replaces that whiteboard) or Rename (asks for another name); a name that is not allowed is asked again. Links pointing to a card or property that does not exist are dropped. Cards without `properties` get an empty list; a card whose position is not a number is an error. A file without a `name`, `cards` and `links` is rejected with an error, and the open board is kept.
- Export: downloads `<name>.json`. Where the browser supports `showSaveFilePicker` (Chromium), a save dialog opens with that name filled in. Otherwise the file goes to the download folder. Export does not affect the saved whiteboard.
- The toolbar buttons are disabled until a whiteboard is open.
- Zoom: zoom in, zoom out and reset (100%) buttons, plus Ctrl + mouse wheel at the cursor. Zoom ranges from 25% to 200%.
- Moving around: the board has no edges or scrollbars. Dragging empty board space with the right mouse button pans the board, keeping the point under the cursor in place; the browser menu does not open there. The mouse wheel scrolls up and down and Shift + wheel sideways; over the scrolling property list of a card with a fixed height, the wheel scrolls the list.
- A new board starts at the origin, and an opened board starts with its top-left card in view. Zoom and view position are view settings and are not saved in the file.

### Cards

- Create card: one dialog asks for the name and a template from a dropdown, which always starts at Empty. Choosing a template shows one row per field: a checkbox (checked by default), the tag and a content input. Every checked field becomes a property, in template order, also when its content is left blank; unchecked fields are left out. A broken template file is reported in the dialog, which then offers only Empty.
- A new card has no picture. It appears in the visible part of the board.
- Layout from top to bottom: header with the name and the rename, delete and link buttons, picture area with the update picture button, property list, and add property button.
- Rename card: asks for a new name, pre-filled with the current one.
- Update picture: accepts PNG and JPG. The image is scaled down on a canvas to at most 480 wide, keeping its aspect ratio, before it is stored. This keeps the JSON file small while pictures stay sharp on wider cards.
- Resize: dragging the handle in the bottom right corner sets the width and height (at least 160 x 80). A card with a fixed height shrinks its picture and scrolls its property list to fit; a link to a property scrolled out of view attaches to the card's edge. Dragging only sideways keeps a fitting card fitting. Double-clicking the handle makes the height fit the content again. A new card is 220 wide and fits its content.
- Delete card: removes the card and every link attached to it or to its properties.
- Select: dragging empty board space with the left mouse button draws a rectangle, and the cards fully inside it are selected (replacing the previous selection) and get a blue outline. Ctrl or Shift + click on a card header adds the card to the selection or removes it. Links are not selected.
- Dragging the header of a selected card moves all selected cards together. Dragging an unselected card clears the selection and moves only that card.
- Clicking empty board space or pressing Escape clears the selection. The selection is a view setting and is not saved in the file.

### Properties

- Shown as `<Tag>: <Content>`, with up, down, edit, delete and link buttons on each row.
- Adding a property asks for tag and content in one dialog. The tag is required; the content may be empty, which shows as `<Tag>:`.
- Edit property: asks for tag and content again, pre-filled with the current values. The property keeps its ID, so its links stay attached.
- Delete property: asks for confirmation, then removes the property and every link attached to it.

### Links

- Clicking a link button enters link mode with that card or property as the source. The next click on a card or property of a different card becomes the target, and the link is created. Pressing Escape, clicking the source's own card, or clicking empty board space cancels link mode. Clicking an existing link leaves link mode and selects that link.
- A new link is solid black with direction `forward`.
- Anchors: a card link attaches to the card's border. A property link attaches to the left or right edge of the property row, whichever side faces the other endpoint.
- Every link is drawn twice: a visible line, and a wide transparent line underneath that makes clicking easy.
- Clicking a link selects it and opens a small panel to edit it:
  - Color: black, red, blue, green, orange, purple, gray.
  - Style: solid, dashed or dotted.
  - Direction: A to B, B to A or undirected, where A is the source and B is the target.
  - Message: saved on Enter or when the field loses focus. A non-empty message is shown at the middle of the line in the link's color, on a box that hides the line behind it. Clicking the message also selects the link. An empty field removes it.
  - Delete button.
- A new link has no message.
- Clicking empty board space or pressing Escape deselects the link.

### Search

- A search box sits in the top right corner of the whiteboard. Its button minimizes it to a small "Search" button and restores it. The link panel appears below it.
- Wildcards: `*` matches any run of characters and `?` matches one character. All other characters are literal. Wildcard matching is case-insensitive and matches anywhere in the text.
- Four tabs choose what is searched:
  - Global: one keyword, matched against card names, the `<Tag>: <Content>` text of properties and link messages.
  - Card: one keyword, matched against card names only.
  - Link: one keyword, matched against link messages only. Links without a message never match. Global, Card and Link share the keyword field.
  - Property: a Tag field and a Content field. A property matches when its tag equals the Tag field, ignoring case and without wildcards, and its content matches the Content field with wildcards. An empty Content field matches every property with that tag. Nothing is highlighted until a tag is entered.
- Matching cards and properties are highlighted in light yellow. A matching property inside a matching card uses a stronger yellow. A matching link gets a yellow band along the line and a yellow box behind its message. The number of matches is shown next to the tabs, also while the box is minimized.
- Highlights update as the board changes. The search is a view setting and is not saved in the file.

### Assistant

- The chat panel is always in the bottom right corner of the whiteboard. Its button minimizes it to its header and restores it. Without an open board its controls are disabled.
- A dropdown in the panel header chooses the model, starting with the default. The choice applies to the next message and is not saved in the file.
- Enter sends a message and Shift+Enter starts a new line. Each request to the model includes a snapshot of the current whiteboard (JSON, pictures left out).
- The request runs in the background and the user can keep working, including opening, creating and importing whiteboards. Only Send, Clear and the model choice are disabled until the assistant answers. A card drag is not interrupted; the assistant's changes are drawn when it ends.
- If the user changes the whiteboard (or opens another one) while the assistant works, the assistant can still search and answer, but its remaining changes in that turn are blocked. Changes it made before stay. Blocked actions are marked in the chat, and a yellow notice says the changes were blocked.
- The assistant can rename the whiteboard; add cards, also from a template (filling in some fields, leaving others empty or leaving fields out); rename, move, resize and delete cards; add, edit, reorder and delete properties; add, restyle and delete links and set their messages; and search. It cannot see or change pictures.
- Each delete it attempts opens a confirmation dialog. A declined delete is reported back to the assistant.
- The chat shows the user's messages, the assistant's replies, and a short gray line for each action, red when the action failed. Errors such as a missing API key are shown in red at the end. If a message fails before the model answers, it is taken out of the chat and put back in the text box.
- The chat is saved with the whiteboard. If the user opens another whiteboard during a turn, the rest of that turn is not saved. Clear deletes the chat history after a confirmation.

## Out of Scope for the First Version

Undo, and links between two properties of the same card.
