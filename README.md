# Detective Whiteboard

A browser-based whiteboard for organizing a case: cards with pictures and properties, connected by links. The requirements are listed in `CLAUDE.md`; this document describes the design.

## Running

```
uv run detective-whiteboard
```

This starts a local web server on `http://127.0.0.1:8000/` and opens the whiteboard in the default browser.

The AI assistant needs an OpenAI API key in a `.env` file in the project folder (ignored by git):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-6-luna
```

The chat panel offers `gpt-6-luna` and `gpt-6.2-astra` (`MODELS` in `__init__.py`). `OPENAI_MODEL` is optional and sets the default model, `gpt-6-luna` if unset; a model not in the list is added to it. `MODELS` also sets the reasoning effort sent with each model: `none` for `gpt-6-luna`, and nothing for `gpt-6.2-astra`, which then uses its own default (it does not accept `none`). A model added through `OPENAI_MODEL` gets no reasoning effort. Without a key the rest of the app works and the assistant reports the missing key.

Options:

- `--port N` sets the port (default 8000).
- `--host 0.0.0.0` allows access from other machines on the LAN at `http://<server IP>:<port>/`. The port may need to be opened in the firewall (for example `sudo firewall-cmd --add-port=8000/tcp`). There is no authentication, and anyone who can reach the server can use the assistant with your API key. Browsers only offer the save dialog on `localhost` or HTTPS, so on a LAN address Save downloads the file instead.

## Architecture

The application is a single-page web app served by a minimal Python server.

- Backend: `src/detective_whiteboard/__init__.py`. `main()` loads `.env` (`python-dotenv`), serves the `static/` directory (on `127.0.0.1` by default, with `Cache-Control: no-cache` so the browser picks up updated files) using the standard library `http.server` and opens the browser. `GET /api/models` returns the selectable models and the default. `POST /api/chat` forwards `instructions`, `input` and `tools` to the OpenAI Responses API with the API key added, using the requested `model` (which must be in the list) or the default, so the key never reaches the browser. It sets `store: false`, so nothing is kept at OpenAI, and asks for encrypted reasoning, which the browser sends back with the next request. Errors come back as `{"error": {"message": ...}}`.
- Frontend: `src/detective_whiteboard/static/` with `index.html`, `style.css`, `ops.js`, `assistant.js` and `app.js`. Plain HTML, CSS and JavaScript, with no framework or build step.

All whiteboard state lives in the browser. Saving and loading go through the browser's file dialogs, so the server never touches whiteboard files. For the same reason the browser runs the assistant's chat loop and its tools. A future database backend would add API endpoints to the server without changing the data model.

### Frontend structure

- State: one `board` object that matches the JSON file format below.
- Operations (`ops.js`): every change to a board is a function of the `ops` object, so the user interface and a future AI assistant share the same code. The functions only change the board data and never touch the page. They take the board and JSON-friendly arguments, refer to cards, properties and links by ID, and return the new card, property or link where there is one. Bad input (unknown ID, blank text, invalid color, style or direction, a link within one card) throws an `Error` with a readable message.
  - Whiteboard: `newBoard(name)`, `loadBoard(data)`, `renameBoard(board, name)`.
  - Cards: `addCard(board, {name, x, y})`, `renameCard(board, cardId, name)`, `moveCard(board, cardId, x, y)`, `resizeCard(board, cardId, width, height)` (`height` `null` fits the content), `setCardPicture(board, cardId, dataUrl)`, `deleteCard(board, cardId)`.
  - Properties: `addProperty(board, cardId, {tag, content})`, `editProperty(board, cardId, propertyId, {tag, content})` (either field may be left out), `moveProperty(board, cardId, propertyId, position)` (0 is the top), `deleteProperty(board, cardId, propertyId)`.
  - Links: `addLink(board, source, target, {color, style, direction, message})`, `updateLink(board, linkId, {color, style, direction, message})`, `deleteLink(board, linkId)`. An endpoint is `{card}` or `{card, property}`. A color is a name from `ops.COLORS` or `#rrggbb`. Deleting a card or property also deletes its links.
  - Search: `search(board, {mode, keyword, tag, content})` returns `{cards: [cardId], properties: [{card, property}], links: [linkId]}`.
- Assistant (`assistant.js`): one tool per operation (except creating, loading, pictures and chat), a system prompt with the current board (pictures left out), and `assistant.send(board, text, hooks)`, which calls `/api/chat` and runs tool calls until the model answers in text. A tool error is returned to the model as `{"error": ...}`. Every tool except `search` changes the board and is blocked once `hooks.stale()` reports that the user changed the board during the turn. It does not touch the page; `hooks` let the user interface redraw, confirm deletes, place new cards and report user edits.
- User interface (`app.js`): dialogs, file handling, dragging, zoom and rendering. Every user action makes its change through `ops` and then calls `render()`.
- Rendering: `render()` rebuilds the board from `board`. Cards are absolutely positioned `div` elements inside a board content element, which sits in a scrollable viewport. Links are drawn on an SVG layer inside the same content element, so cards and links share one coordinate system. The board content is at least 4000 x 3000 and grows to keep a margin past the farthest card.
- Zoom: a CSS `transform: scale(zoom)` on the content element scales cards and links together. Pointer positions are divided by `zoom` to convert them to board coordinates.
- Dragging: the card header is the drag handle. Pointer events update the card's `x` and `y`, and links are redrawn while the card moves.
- Dialogs: one in-page `<dialog>`, styled like the cards, is used for all input, confirmations and error messages. A dialog requested while another is open waits until that one closes. `showDialog()` fills in a title, an optional message and labeled text fields, and returns a promise with the trimmed values, or `null` on Cancel. Enter confirms, Escape cancels, and blank fields are rejected. The browser's own prompt is used only for the leave-page warning.

## Data Model and File Format

A whiteboard is saved as one self-contained JSON file named `<whiteboard name>.json`.

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

### Whiteboard

- Create: asks for a name and starts an empty board.
- Save: downloads `<name>.json`. Where the browser supports `showSaveFilePicker` (Chromium), a save dialog opens with that name filled in. Otherwise the file goes to the download folder. If writing the file fails, an error is shown and the board stays marked as unsaved.
- Load: opens a file dialog for `.json` files. The whiteboard name is taken from the file's contents, not from the file name. Links pointing to a card or property that does not exist are dropped. A file without a `name`, `cards` and `links` is rejected with an error, and the open board is kept.
- Rename: changes `name`, which is used for the next save.
- Create and Load ask for confirmation when the current board has unsaved changes.
- Every button except Create and Load is disabled until a board is open.
- Zoom: zoom in, zoom out and reset (100%) buttons, plus Ctrl + mouse wheel. Zoom ranges from 25% to 200%. It is a view setting and is not saved in the file.

### Cards

- A new card has no picture and no properties. It appears in the visible part of the board.
- Layout from top to bottom: header with the name and the rename, delete and link buttons, picture area with the update picture button, property list, and add property button.
- Rename card: asks for a new name, pre-filled with the current one.
- Update picture: accepts PNG and JPG. The image is scaled down on a canvas to at most 480 wide, keeping its aspect ratio, before it is stored. This keeps the JSON file small while pictures stay sharp on wider cards.
- Resize: dragging the handle in the bottom right corner sets the width and height (at least 160 x 80). A card with a fixed height shrinks its picture and scrolls its property list to fit; a link to a property scrolled out of view attaches to the card's edge. Double-clicking the handle makes the height fit the content again. A new card is 220 wide and fits its content.
- Delete card: removes the card and every link attached to it or to its properties.

### Properties

- Shown as `<Tag>: <Content>`, with up, down, edit, delete and link buttons on each row.
- Adding a property asks for tag and content in one dialog.
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
- Clicking empty board space deselects the link.

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
- The request runs in the background and the user can keep working, including Create and Load. Only Send, Clear and the model choice are disabled until the assistant answers. A card drag is not interrupted; the assistant's changes are drawn when it ends.
- If the user changes the whiteboard (or opens another one) while the assistant works, the assistant can still search and answer, but its remaining changes in that turn are blocked. Changes it made before stay. Blocked actions are marked in the chat, and a yellow notice says the changes were blocked.
- The assistant can rename the whiteboard; add, rename, move, resize and delete cards; add, edit, reorder and delete properties; add, restyle and delete links and set their messages; and search. It cannot see or change pictures.
- Each delete it attempts opens a confirmation dialog. A declined delete is reported back to the assistant.
- The chat shows the user's messages, the assistant's replies, and a short gray line for each action, red when the action failed. Errors such as a missing API key are shown in red at the end.
- The chat is saved with the whiteboard, and every message marks the board as unsaved. Clear deletes the chat history after a confirmation.

## Out of Scope for the First Version

Undo, and links between two properties of the same card.
