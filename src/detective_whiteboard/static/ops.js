"use strict";

// Every change that can be made to a whiteboard, as plain functions on a board object.
// They do not touch the page, take and return JSON-friendly values, and throw an Error with a
// readable message on bad input, so the user interface and an AI assistant can share them.
// The caller is responsible for redrawing and marking the board as changed.
const ops = (() => {
  const COLORS = {
    black: "#000000",
    red: "#d32f2f",
    blue: "#1e6fd9",
    green: "#2e7d32",
    orange: "#ef6c00",
    purple: "#7b1fa2",
    gray: "#757575",
  };
  const STYLES = ["solid", "dashed", "dotted"];
  const DIRECTIONS = ["forward", "backward", "none"];
  const SEARCH_MODES = ["global", "card", "property", "link"];
  const CARD_SIZE = { width: 220, minWidth: 160, minHeight: 80 };

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function text(value, what) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) throw new Error(`${what} must not be blank`);
    return trimmed;
  }

  function coordinate(value, what) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${what} must be a number`);
    return Math.round(number);
  }

  function oneOf(value, allowed, what) {
    if (!allowed.includes(value)) throw new Error(`${what} must be one of: ${allowed.join(", ")}`);
    return value;
  }

  function getCard(board, cardId) {
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`No card with ID "${cardId}"`);
    return card;
  }

  function getProperty(board, cardId, propertyId) {
    const prop = getCard(board, cardId).properties.find((p) => p.id === propertyId);
    if (!prop) throw new Error(`Card "${cardId}" has no property with ID "${propertyId}"`);
    return prop;
  }

  function getLink(board, linkId) {
    const link = board.links.find((l) => l.id === linkId);
    if (!link) throw new Error(`No link with ID "${linkId}"`);
    return link;
  }

  // ---------- Whiteboard ----------

  function newBoard(name) {
    return { version: 1, name: text(name, "Whiteboard name"), cards: [], links: [], chat: [] };
  }

  // Whether the card, or the property of the card, of an endpoint { card, property } exists.
  function endpointExists(board, { card, property }) {
    const found = board.cards.find((c) => c.id === card);
    return !!found && (!property || found.properties.some((p) => p.id === property));
  }

  // Checks parsed file data and drops links whose card or property does not exist.
  function loadBoard(data) {
    if (typeof data?.name !== "string" || !Array.isArray(data.cards) || !Array.isArray(data.links)) {
      throw new Error("not a whiteboard file");
    }
    for (const card of data.cards) {
      card.properties ??= [];
      card.x = coordinate(card.x, `Card ${card.name} x`);
      card.y = coordinate(card.y, `Card ${card.name} y`);
      card.width ??= CARD_SIZE.width;
      card.height ??= null;
    }
    data.links = data.links.filter((l) => endpointExists(data, l.source) && endpointExists(data, l.target));
    for (const link of data.links) link.message ??= "";
    data.chat ??= [];
    return data;
  }

  function renameBoard(board, name) {
    board.name = text(name, "Whiteboard name");
  }

  // ---------- Cards ----------

  // properties is a list of { tag, content }, for example the fields of a card template.
  function addCard(board, { name, x = 0, y = 0, properties = [] }) {
    const card = {
      id: uid("c"),
      name: text(name, "Card name"),
      x: coordinate(x, "x"),
      y: coordinate(y, "y"),
      width: CARD_SIZE.width,
      height: null,
      picture: null,
      properties: properties.map(newProperty),
    };
    board.cards.push(card);
    return card;
  }

  function renameCard(board, cardId, name) {
    getCard(board, cardId).name = text(name, "Card name");
  }

  function moveCard(board, cardId, x, y) {
    const card = getCard(board, cardId);
    card.x = coordinate(x, "x");
    card.y = coordinate(y, "y");
  }

  // height null makes the card as tall as its content.
  function resizeCard(board, cardId, width, height) {
    const card = getCard(board, cardId);
    card.width = Math.max(CARD_SIZE.minWidth, coordinate(width, "Width"));
    card.height = height === null ? null : Math.max(CARD_SIZE.minHeight, coordinate(height, "Height"));
  }

  // picture is an image data URL, or null to remove the picture.
  function setCardPicture(board, cardId, picture) {
    getCard(board, cardId).picture = picture;
  }

  // Also deletes every link attached to the card or its properties.
  function deleteCard(board, cardId) {
    getCard(board, cardId);
    board.cards = board.cards.filter((c) => c.id !== cardId);
    board.links = board.links.filter((l) => l.source.card !== cardId && l.target.card !== cardId);
  }

  // ---------- Properties ----------

  // The tag must not be blank; the content may be empty.
  function newProperty({ tag, content = "" }) {
    return { id: uid("p"), tag: text(tag, "Tag"), content: String(content).trim() };
  }

  function addProperty(board, cardId, { tag, content }) {
    const prop = newProperty({ tag, content });
    getCard(board, cardId).properties.push(prop);
    return prop;
  }

  // Changes the tag, the content or both. The property keeps its ID, so its links stay attached.
  function editProperty(board, cardId, propertyId, { tag, content }) {
    const prop = getProperty(board, cardId, propertyId);
    if (tag !== undefined) prop.tag = text(tag, "Tag");
    if (content !== undefined) prop.content = String(content).trim();
  }

  // Moves a property to a position in the card's list, counted from 0 at the top.
  function moveProperty(board, cardId, propertyId, position) {
    const props = getCard(board, cardId).properties;
    const from = props.indexOf(getProperty(board, cardId, propertyId));
    if (!Number.isInteger(position) || position < 0 || position >= props.length) {
      throw new Error(`Position must be a whole number from 0 to ${props.length - 1}`);
    }
    props.splice(position, 0, ...props.splice(from, 1));
  }

  // Also deletes every link attached to the property.
  function deleteProperty(board, cardId, propertyId) {
    getProperty(board, cardId, propertyId);
    const card = getCard(board, cardId);
    card.properties = card.properties.filter((p) => p.id !== propertyId);
    board.links = board.links.filter((l) => l.source.property !== propertyId && l.target.property !== propertyId);
  }

  // ---------- Links ----------

  // An endpoint is { card } for a card or { card, property } for a property of that card.
  function endpoint(board, { card, property = null }) {
    if (property) getProperty(board, card, property);
    else getCard(board, card);
    return { card, property };
  }

  // color is a name from COLORS or "#rrggbb"; style is in STYLES; direction is in DIRECTIONS;
  // message is the text shown on the line, empty for none.
  function applyLinkChanges(link, { color, style, direction, message }) {
    const changes = {};
    if (color !== undefined) {
      changes.color = COLORS[color] ?? color;
      if (!/^#[0-9a-f]{6}$/i.test(changes.color)) {
        throw new Error(`Color must be one of: ${Object.keys(COLORS).join(", ")}, or #rrggbb`);
      }
    }
    if (style !== undefined) changes.style = oneOf(style, STYLES, "Style");
    if (direction !== undefined) changes.direction = oneOf(direction, DIRECTIONS, "Direction");
    if (message !== undefined) changes.message = String(message).trim();
    Object.assign(link, changes);
  }

  // A new link is solid black, has no message and points from source to target unless changes say otherwise.
  function addLink(board, source, target, changes = {}) {
    const link = {
      id: uid("l"),
      source: endpoint(board, source),
      target: endpoint(board, target),
      color: COLORS.black,
      style: "solid",
      direction: "forward",
      message: "",
    };
    if (link.source.card === link.target.card) throw new Error("A link must connect two different cards");
    applyLinkChanges(link, changes);
    board.links.push(link);
    return link;
  }

  function updateLink(board, linkId, changes) {
    applyLinkChanges(getLink(board, linkId), changes);
  }

  function deleteLink(board, linkId) {
    getLink(board, linkId);
    board.links = board.links.filter((l) => l.id !== linkId);
  }

  // ---------- Chat ----------

  // The assistant's chat is stored in board.chat as Responses API input items (see assistant.js).
  function clearChat(board) {
    board.chat = [];
  }

  // ---------- Search ----------

  // "*" matches any run of characters and "?" one character; everything else is literal.
  function wildcardRegExp(pattern) {
    const source = [...pattern]
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    return new RegExp(source, "i");
  }

  // Modes:
  // - "global": keyword against card names, the "Tag: Content" text of properties and link messages.
  // - "card": keyword against card names only.
  // - "link": keyword against link messages only; links without a message never match.
  // - "property": tag equals the property tag (ignoring case, no wildcards) and content matches
  //   its content; an empty content matches every property with that tag.
  // Wildcard matching ignores case and matches anywhere in the text.
  // Returns the IDs of matching cards and links, and the { card, property } IDs of matching properties.
  function search(board, { mode = "global", keyword, tag, content = "" }) {
    let cardMatches = () => false;
    let propertyMatches = () => false;
    let linkMatches = () => false;
    if (oneOf(mode, SEARCH_MODES, "Search mode") === "property") {
      const wanted = text(tag, "Tag").toLowerCase();
      const pattern = wildcardRegExp(String(content).trim());
      propertyMatches = (p) => p.tag.toLowerCase() === wanted && pattern.test(p.content);
    } else {
      const pattern = wildcardRegExp(text(keyword, "Keyword"));
      if (mode !== "link") cardMatches = (c) => pattern.test(c.name);
      if (mode === "global") propertyMatches = (p) => pattern.test(`${p.tag}: ${p.content}`);
      if (mode === "global" || mode === "link") linkMatches = (l) => !!l.message && pattern.test(l.message);
    }
    return {
      cards: board.cards.filter(cardMatches).map((c) => c.id),
      properties: board.cards.flatMap((c) =>
        c.properties.filter(propertyMatches).map((p) => ({ card: c.id, property: p.id })),
      ),
      links: board.links.filter(linkMatches).map((l) => l.id),
    };
  }

  return {
    COLORS,
    STYLES,
    DIRECTIONS,
    SEARCH_MODES,
    CARD_SIZE,
    getCard,
    getProperty,
    getLink,
    endpointExists,
    newBoard,
    loadBoard,
    renameBoard,
    addCard,
    renameCard,
    moveCard,
    resizeCard,
    setCardPicture,
    deleteCard,
    addProperty,
    editProperty,
    moveProperty,
    deleteProperty,
    addLink,
    updateLink,
    deleteLink,
    clearChat,
    search,
  };
})();
