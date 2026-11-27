# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project: Detective Whiteboard

This project is about building a browser-based detective whiteboard application. A brief introduction of the application and implementation rules are given in this document `./CLAUDE.md`. A detailed illustration is given in the separate document `./README.md`.

This project is jointly developed by human developer and vibe coding agent.

## Current State and Commands

- First version implemented as described in `README.md`: `src/detective_whiteboard/__init__.py` (static server, whiteboard storage in `./data` and `/api/chat` proxy to OpenAI) and `src/detective_whiteboard/static/` (`index.html`, `style.css`, `ops.js` for all board operations, `assistant.js` for the AI assistant, `app.js` for the user interface). Progress is tracked in `PLAN.md`.
- Card templates are in `./card_template.json`.
- Run the app: `uv run detective-whiteboard` (options `--host`, `--port`; `--host 0.0.0.0` for LAN access). The assistant needs `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `./.env`.
- Add a dependency: `uv add <package>` (dev-only: `uv add --dev <package>`)
- No test framework or linter. Check JavaScript syntax with `node --check` on the `.js` files in `src/detective_whiteboard/static/`, and test manually in the browser.

## Brief Introduction

In detective movies, the detective would put the pictures of the people and location involved in the case on a whiteboard. Down to the pictures are bullet points summarizing the information of the item. Lines are drawn linking pictures, bullet points across pictures, or a bullet point of a picture to another picture.

This project is about building such a detective whiteboard.

## Basic Requirements

### Interface

The application has a browser-based graphical user interface with the following features.

Whiteboard storage:

- It has a create button that allows the user to create a new whiteboard. When the user creates a new whiteboard, they must give a name to the whiteboard.
- The server manages the whiteboards for a single user without login, one JSON file per whiteboard in `./data` in the project folder. The name of the JSON file is the name of the whiteboard, so a name must not contain `/ \ : * ? " < > |`. The JSON file is self-contained and has all the information of the whiteboard, including the cards created, the properties of the cards, the links, and the locations of the cards.
- Changes to the open whiteboard are saved automatically, about one second after the last change and when the user switches whiteboards or leaves the page. There is no save button; the toolbar shows the save status.
- Creating a whiteboard creates its JSON file. The user can open (switch to) any saved whiteboard from a list, save the open one as a copy under a new name, rename it (which renames the file) and delete it (which closes it).
- The last opened whiteboard is kept in `./data/last_whiteboard.txt` and opens on startup. It is a separate file rather than taken from file times because the files are temporary: whiteboards may move to MongoDB and links to SQLite.
- Import uploads a JSON file from the user's computer as a new whiteboard under the name inside it; if the name is taken the user chooses to overwrite or rename. Export downloads the open whiteboard as a JSON file. Neither counts as saving.

Whiteboard and card management:

Once a whiteboard is created or opened, the following features are enabled.

- It has a rename button that allows the user to rename the whiteboard.
- The user can zoom the entire whiteboard in and out, with cards and links scaled together.
- The whiteboard has no edges and feels infinite. The user pans it by dragging empty space with the right mouse button.
- It has a create card button that allows the user to create a new card. The user needs to provide a name to the card. Upon creation, the card has an empty picture, and an empty list of properties. The name of the card is displayed on the top of the card.
- Card templates are not hardcoded: `card_template.json` in the project folder lists them (a name and its field tags), and it is read each time a card is created. The create card box asks for the name and a template from a dropdown starting at Empty. A non-empty template shows its fields, each with a checkbox (checked by default) and a content input; checked fields are added as properties even when left empty, unchecked ones are left out. Property content may be empty everywhere. The assistant can also create cards from templates.
- The card has an update picture button, that allows the user to upload a picture from local machine. A browsing pop up should appear and the user can select a picture (PNG or JPG) to be loaded, and then the picture will be automatically sized properly and displayed on the card.
- The user can drag and move the card in the UI.
- The user can select several cards by dragging a rectangle over empty space with the left mouse button (cards fully inside are selected), add or remove a card with Ctrl or Shift + click on its header, and move the selected cards together. Only cards are selected, not links.
- On each card, there is a add property button that allows the user to add a property. Each property has two fields, "Tag" and "Content". The user needs to provide the tag and the content of a property when adding one. The property will then be displayed down the picture of the card, in the form of "<Tag>: <Content>".
- On each card, there is a rename card button that allows the user to rename the card.
- On each property, there is an edit property button that allows the user to change its tag and content.
- On each property, there is a delete property button that allows the user to delete a property.
- On each card, there is a delete card button that allows the user to delete the card.
- The order of the property displayed on the card follow the sequence they are added to the card by default, with the earlier added property displayed on the top, closer to the picture. The user is allowed to change the order of the properties. There are up-arrow and down-arrow buttons on each property that allow the user to change their order.

Link management:

- On each card and on each property, there is an add link button. Once the user click that button, and then click another card or the property of another card, a link will be created and link the card or property to the other card of the property.
- The link is a solid black line with direction. An arrow points from the source to the destination.
- The user can select a link by clicking the line. The user can change the property of the link, including the color (commonly used colors should be provided), the shape (solid, dashed or dot), the direction of the arrow (A to B, B to A, or undirected). The user can also delete the link.
- Each link has a message, which the user can add or edit in the link panel. A non-empty message is displayed on the line.
- The user can resize cards.

Not planned: undo.

### Backend Storage

- The server stores each whiteboard as self-contained JSON in `./data`. In the future, the whiteboards might move to MongoDB and the links to SQLite.

## General Rules

The following rules must be obeyed by the vibe coding agent.

- Avoid over complicated development and testing procedures.
- Comment the code only when necessary.
- Be concise with `./README.md` and do not use emojis.
- Use `./PLAN.md` to plan the development phases first, before carrying out the execution.
- Avoid overly defensive programming and instance checks, and use exceptions only when necessary.
- Use `uv` to manage libraries and use `uv run xxx` to execute the program.

