import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const contextMenuSource = [
  section("function messageFromRenderedElement", "function renderedMessageRows"),
  section("function handleMessageContextMenu", "function SearchablePicker"),
].join("\n");

// Model DOM ancestry and selector matching independently of the click handler.
class Element {
  constructor({ parentElement = null, id = "", className = "", dataset = {}, message } = {}) {
    Object.assign(this, { parentElement, id, className, dataset, message });
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = selector.match(/^\[([\w-]+)(\^=|=)"([^"]*)"\]$/);
    if (!attribute) return false;
    const [, name, operator, expected] = attribute;
    const value = name === "id" ? this.id : this[name];
    return typeof value === "string" && (operator === "^=" ? value.startsWith(expected) : value === expected);
  }

  closest(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    for (let element = this; element; element = element.parentElement) {
      if (selectors.some((part) => element.matches(part))) return element;
    }
    return null;
  }
}

function harness({ marked = true, archived = true, deleted = true } = {}) {
  const message = { id: "123456", channel_id: "100" };
  const row = new Element({
    id: `chat-messages-${message.channel_id}-${message.id}`,
    className: marked ? "alexandria-deleted-message" : "",
    dataset: marked ? { alexandriaMessageId: message.id } : {},
    message: marked ? undefined : message,
  });
  const header = new Element({ parentElement: row });
  const targets = {
    "row padding": row,
    "header whitespace beyond the timestamp": header,
    "username": new Element({ parentElement: header, id: `message-username-${message.id}`, message }),
    "timestamp": new Element({ parentElement: header, id: `message-timestamp-${message.id}`, message }),
    "message text": new Element({ parentElement: row, id: `message-content-${message.id}`, message }),
  };
  const items = [];
  const callbacks = [];
  const context = vm.createContext({
    Element,
    entries: () => archived ? [{ id: message.id, deleted }] : [],
    asString: (value) => value == null ? "" : String(value),
    getProps: (element) => ({ message: element?.message }),
    getFiber: () => null,
    reactFiberWalker: () => null,
    addArchiveContextMenuItem: (entry) => items.push(entry.id),
    setTimeout: (callback) => callbacks.push(callback),
  });
  vm.runInContext(`${contextMenuSource}\nglobalThis.handle = handleMessageContextMenu;`, context);
  return {
    targets, row, message, items,
    open(target) {
      context.handle({ target });
      callbacks.splice(0).forEach((callback) => callback());
    },
  };
}

for (const target of ["row padding", "header whitespace beyond the timestamp", "username", "timestamp", "message text"]) {
  test(`deleted-message context menu includes archive removal from ${target}`, () => {
    const h = harness();
    h.open(h.targets[target]);
    assert.deepEqual(h.items, [h.message.id]);
  });
}

test("unmarked Discord rows can still resolve the archived message through their props", () => {
  const h = harness({ marked: false });
  h.open(h.targets["header whitespace beyond the timestamp"]);
  assert.deepEqual(h.items, [h.message.id]);
});

test("a nested message preview cannot select a different entry than the enclosing deleted row", () => {
  const h = harness();
  const preview = new Element({ parentElement: h.row, id: "message-content-987654", message: { id: "987654" } });
  h.open(preview);
  assert.deepEqual(h.items, [h.message.id]);
});

for (const options of [{ archived: false }, { deleted: false }]) {
  test(`archive removal stays absent for ${options.archived === false ? "unarchived" : "undeleted"} messages`, () => {
    const h = harness(options);
    Object.values(h.targets).forEach((target) => h.open(target));
    assert.deepEqual(h.items, []);
  });
}

test("right-clicks outside message rows do not add archive removal", () => {
  const h = harness();
  h.open(new Element());
  h.open(null);
  assert.deepEqual(h.items, []);
});
