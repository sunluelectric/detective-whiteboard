"use strict";

// The AI assistant: tools over ops, the system prompt, and the chat loop. It does not touch the page.
// The chat is stored in board.chat as Responses API input items, so it is saved with the whiteboard.
// The server at /api/chat adds the API key and forwards each request to OpenAI.
const assistant = (() => {
  const MAX_STEPS = 20;

  const string = (description) => ({ type: "string", description });
  const number = (description) => ({ type: "number", description });
  const endpoint = {
    type: "object",
    description: "A card, or a property of a card",
    properties: {
      card: string("Card ID"),
      property: string("Property ID; leave out to use the card itself"),
    },
    required: ["card"],
  };
  const linkLook = {
    color: string(`One of: ${Object.keys(ops.COLORS).join(", ")}, or #rrggbb`),
    style: { type: "string", enum: ops.STYLES },
    direction: {
      type: "string",
      enum: ops.DIRECTIONS,
      description: "forward: arrow from source to target; backward: arrow from target to source; none: no arrow",
    },
    message: string("Text shown on the line; empty for none"),
  };
  const linkChanges = (a) => ({ color: a.color, style: a.style, direction: a.direction, message: a.message });
  const propertyLabel = (board, cardId, propertyId) => {
    const prop = ops.getProperty(board, cardId, propertyId);
    return `"${prop.tag}: ${prop.content}" of card "${ops.getCard(board, cardId).name}"`;
  };
  const endpointLabel = (board, { card, property }) =>
    property ? propertyLabel(board, card, property) : `card "${ops.getCard(board, card).name}"`;

  // The { tag, content } list for add_card from its template, contents and skip arguments.
  function templateProperties(templates, { template, contents = {}, skip = [] }) {
    if (template === undefined) {
      if (Object.keys(contents).length || skip.length) throw new Error("contents and skip need a template");
      return [];
    }
    const tags = templates[template];
    if (!tags) throw new Error(`No template "${template}". Templates: ${Object.keys(templates).join(", ") || "none"}`);
    for (const tag of [...Object.keys(contents), ...skip]) {
      if (!tags.includes(tag)) throw new Error(`Template "${template}" has no field "${tag}". Fields: ${tags.join(", ")}`);
    }
    return tags.filter((tag) => !skip.includes(tag)).map((tag) => ({ tag, content: contents[tag] ?? "" }));
  }

  const BLOCKED =
    "Blocked: the user changed the whiteboard while you were working, so you cannot change it until the user " +
    "sends a new message. Do not retry. Answer from the current whiteboard and say which changes you did not make.";
  const NOTICE =
    "The whiteboard was changed while the assistant was working, so its changes were blocked. Send the request " +
    "again to retry.";

  // run(board, args, hooks) makes the change and returns what the model sees.
  // confirm(board, args) returns the question shown to the user before a delete.
  // readOnly tools still run after the user changed the whiteboard during a turn; all others are blocked.
  const TOOLS = {
    rename_whiteboard: {
      description: "Rename the whiteboard.",
      parameters: { name: string("New name") },
      required: ["name"],
      run: (board, a) => ops.renameBoard(board, a.name),
    },
    add_card: {
      description:
        "Add a card with a name and no picture. Without a template it has no properties; with a template it " +
        "gets one property per template field, in order, except the fields in skip. Contents fills in fields; " +
        "the others are left empty. Returns the new card with its ID and property IDs. " +
        "Leave out x and y to place it in the part of the board the user is looking at.",
      parameters: {
        name: string("Card name"),
        x: number("Left edge"),
        y: number("Top edge"),
        template: string("Name of a card template; leave out for a card without properties"),
        contents: {
          type: "object",
          description: "Content for template fields, by tag, for example {\"Age\": \"42\"}",
          additionalProperties: { type: "string" },
        },
        skip: { type: "array", items: { type: "string" }, description: "Tags of template fields to leave out" },
      },
      required: ["name"],
      run: (board, a, hooks) =>
        ops.addCard(board, {
          name: a.name,
          properties: templateProperties(hooks.templates, a),
          ...(a.x === undefined || a.y === undefined ? hooks.cardPosition() : { x: a.x, y: a.y }),
        }),
    },
    rename_card: {
      description: "Rename a card.",
      parameters: { card: string("Card ID"), name: string("New name") },
      required: ["card", "name"],
      run: (board, a) => ops.renameCard(board, a.card, a.name),
    },
    move_card: {
      description: "Move a card to a position on the board.",
      parameters: { card: string("Card ID"), x: number("Left edge"), y: number("Top edge") },
      required: ["card", "x", "y"],
      run: (board, a) => ops.moveCard(board, a.card, a.x, a.y),
    },
    resize_card: {
      description: `Resize a card. The smallest size is ${ops.CARD_SIZE.minWidth} x ${ops.CARD_SIZE.minHeight}.`,
      parameters: { card: string("Card ID"), width: number("Width"), height: number("Height; leave out to fit the content") },
      required: ["card", "width"],
      run: (board, a) => ops.resizeCard(board, a.card, a.width, a.height ?? null),
    },
    delete_card: {
      description: "Delete a card and every link attached to it or its properties. The user is asked to confirm.",
      parameters: { card: string("Card ID") },
      required: ["card"],
      confirm: (board, a) => `The assistant wants to delete card "${ops.getCard(board, a.card).name}" and its links.`,
      run: (board, a) => ops.deleteCard(board, a.card),
    },
    add_property: {
      description: "Add a property (tag and content) at the bottom of a card. Returns the new property with its ID.",
      parameters: { card: string("Card ID"), tag: string("Tag, for example Age"), content: string("Content; may be empty") },
      required: ["card", "tag", "content"],
      run: (board, a) => ops.addProperty(board, a.card, a),
    },
    edit_property: {
      description: "Change the tag, the content or both of a property. Links stay attached.",
      parameters: {
        card: string("Card ID"),
        property: string("Property ID"),
        tag: string("New tag; leave out to keep it"),
        content: string("New content, may be empty; leave out to keep it"),
      },
      required: ["card", "property"],
      run: (board, a) => ops.editProperty(board, a.card, a.property, a),
    },
    move_property: {
      description: "Move a property to a position in its card's list; 0 is the top.",
      parameters: { card: string("Card ID"), property: string("Property ID"), position: { type: "integer" } },
      required: ["card", "property", "position"],
      run: (board, a) => ops.moveProperty(board, a.card, a.property, a.position),
    },
    delete_property: {
      description: "Delete a property and every link attached to it. The user is asked to confirm.",
      parameters: { card: string("Card ID"), property: string("Property ID") },
      required: ["card", "property"],
      confirm: (board, a) => `The assistant wants to delete property ${propertyLabel(board, a.card, a.property)} and its links.`,
      run: (board, a) => ops.deleteProperty(board, a.card, a.property),
    },
    add_link: {
      description:
        "Link two cards, or properties of two different cards. New links are solid black arrows from source to " +
        "target without a message unless color, style, direction or message say otherwise. Returns the new link with its ID.",
      parameters: { source: endpoint, target: endpoint, ...linkLook },
      required: ["source", "target"],
      run: (board, a) => ops.addLink(board, a.source, a.target, linkChanges(a)),
    },
    update_link: {
      description: "Change the color, style, direction or message of a link.",
      parameters: { link: string("Link ID"), ...linkLook },
      required: ["link"],
      run: (board, a) => ops.updateLink(board, a.link, linkChanges(a)),
    },
    delete_link: {
      description: "Delete a link. The user is asked to confirm.",
      parameters: { link: string("Link ID") },
      required: ["link"],
      confirm: (board, a) => {
        const link = ops.getLink(board, a.link);
        return `The assistant wants to delete the link from ${endpointLabel(board, link.source)} to ${endpointLabel(board, link.target)}.`;
      },
      run: (board, a) => ops.deleteLink(board, a.link),
    },
    search: {
      description:
        "Find cards, properties and links. Modes: global (keyword against card names, 'Tag: Content' of properties " +
        "and link messages), card (keyword against card names), property (tag equals the property tag ignoring " +
        "case, and content matches its content), link (keyword against link messages). In keyword and content, * " +
        "matches any characters and ? one character; matching ignores case and can be anywhere in the text. " +
        "Returns the IDs of matching cards, properties and links.",
      parameters: {
        mode: { type: "string", enum: ops.SEARCH_MODES },
        keyword: string("For global, card and link modes"),
        tag: string("For property mode"),
        content: string("For property mode; leave out to match every property with the tag"),
      },
      required: ["mode"],
      readOnly: true,
      run: (board, a) => ops.search(board, a),
    },
  };

  // strict is off because the optional arguments do not fit strict mode's schema rules.
  const TOOL_SCHEMAS = Object.entries(TOOLS).map(([name, tool]) => ({
    type: "function",
    name,
    description: tool.description,
    parameters: { type: "object", properties: tool.parameters, required: tool.required },
    strict: false,
  }));

  // The board as the model sees it: pictures are left out and link colors are named where possible.
  function boardState(board) {
    const colorNames = Object.fromEntries(Object.entries(ops.COLORS).map(([name, value]) => [value, name]));
    return {
      name: board.name,
      cards: board.cards.map(({ id, name, x, y, width, height, picture, properties }) => ({
        id,
        name,
        x,
        y,
        width,
        height,
        hasPicture: !!picture,
        properties,
      })),
      links: board.links.map((l) => ({ ...l, color: colorNames[l.color] ?? l.color })),
    };
  }

  // templates is { templates: { name: [tag] }, error } from /api/templates.
  function systemPrompt(board, templates) {
    return [
      "You are the assistant in a detective whiteboard app. The user organizes a case on a whiteboard of cards",
      "(people, places, objects, events). Each card has a name, an optional picture and an ordered list of",
      "properties shown as 'Tag: Content'. Links connect cards, or properties of two different cards.",
      "",
      "Use the tools to change the whiteboard when the user asks, and answer questions about the case from it.",
      "Refer to cards, properties and links by the IDs in the current whiteboard below; it is updated after",
      "every change. You cannot see or change pictures. The board has no edges and x and y may be negative.",
      "Cards are 220 wide unless resized (height null fits the content). When you place several cards, leave a gap of about 40 between cards side by side and start",
      "each row about 300 below the previous one.",
      "Links can carry a short message shown on the line. Keep replies short and plain text.",
      "",
      "Card templates (name: field tags), for add_card. A property's content may be empty, so a template field",
      "the user gives no content for is added empty unless they ask to leave it out:",
      templates.error ? `Unavailable: ${templates.error}` : JSON.stringify(templates.templates),
      "",
      "Current whiteboard (JSON):",
      JSON.stringify(boardState(board)),
    ].join("\n");
  }

  async function complete(board, model, templates) {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: systemPrompt(board, templates),
        input: board.chat.filter((item) => item.type !== "notice"),
        tools: TOOL_SCHEMAS,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? `Request failed with status ${response.status}`);
    return data.output;
  }

  // Every function call gets an output, even on errors, so the stored chat stays valid for the next request.
  async function runTool(board, call, hooks) {
    try {
      const tool = TOOLS[call.name];
      if (!tool) throw new Error(`Unknown tool ${call.name}`);
      // Models sometimes send null for optional arguments; treat that as left out.
      const args = JSON.parse(call.arguments || "{}", (key, value) => (value === null ? undefined : value));
      const blocked = () => !tool.readOnly && hooks.stale();
      if (blocked()) return { error: BLOCKED, blocked: true };
      if (tool.confirm && !(await hooks.confirm(tool.confirm(board, args)))) {
        return { error: "The user declined this change." };
      }
      // The user may have changed the whiteboard while the confirmation waited behind their own dialog.
      if (blocked()) return { error: BLOCKED, blocked: true };
      return tool.run(board, args, hooks) ?? { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Sends the user's text and runs tools until the model answers without calling one.
  // Output items (reasoning, messages, function calls) are stored exactly as returned, because the
  // model needs its encrypted reasoning back in the next request.
  // If the user changes the whiteboard during the turn, the remaining changes are blocked and the turn
  // ends with a notice item, which is shown in the chat but not sent to the model.
  // hooks: onUpdate() after every change to the board or chat, confirm(question) resolving to
  // true or false, cardPosition() returning { x, y } for a new card, stale() returning true once the
  // user changed the whiteboard since the message was sent, model (empty for the server's default), and
  // loadTemplates() resolving to the card templates, which are read once per turn.
  // If the turn fails before the model answers, the user's message is taken out of the chat again and the
  // error gets unsent = true, so the text can go back into the text box.
  async function send(board, text, hooks) {
    const message = { role: "user", content: text };
    board.chat.push(message);
    hooks.onUpdate();
    let blocked = false;
    let answered = false;
    try {
      const loaded = await hooks.loadTemplates();
      hooks = { ...hooks, templates: loaded.templates };
      for (let step = 0; step < MAX_STEPS; step++) {
        const output = await complete(board, hooks.model, loaded);
        answered = true;
        board.chat.push(...output);
        hooks.onUpdate();
        const calls = output.filter((item) => item.type === "function_call");
        if (!calls.length) return;
        for (const call of calls) {
          const result = await runTool(board, call, hooks);
          blocked ||= !!result.blocked;
          board.chat.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
          hooks.onUpdate();
        }
      }
      throw new Error(`The assistant stopped after ${MAX_STEPS} steps.`);
    } catch (err) {
      if (!answered && board.chat.includes(message)) {
        board.chat.splice(board.chat.indexOf(message), 1);
        hooks.onUpdate();
        err.unsent = true;
      }
      throw err;
    } finally {
      if (blocked) {
        board.chat.push({ type: "notice", text: NOTICE });
        hooks.onUpdate();
      }
    }
  }

  // The visible text of an assistant message item.
  function messageText(item) {
    return item.content.map((part) => part.text ?? part.refusal ?? "").join("");
  }

  return { TOOLS, send, messageText };
})();
