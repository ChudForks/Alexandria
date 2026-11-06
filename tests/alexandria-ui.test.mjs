import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const buildDependencies = createRequire(require.resolve("@uwu/lune/package.json"));
const { transformSync } = buildDependencies("@babel/core");
const shelterDependencies = createRequire(require.resolve("@uwu/shelter-defs/package.json"));
const solid = shelterDependencies(join(dirname(shelterDependencies.resolve("solid-js/package.json")), "dist", "solid.cjs"));
const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const uiSource = [
  section("function asString", "function archiveEntryBytes"),
  section("function attachmentKey", "function normaliseEmbed"),
  section("function serverLabel", "function removeArchiveEntry"),
  section("function SearchablePicker", "function archiveCount"),
  section("function repairMissingArchivedPhoto", "function ArchivedPhoto"),
  section("function PhotoModal", "function openPhoto"),
  section("function ArchiveModal", "function openArchive"),
].join("\n");

// Exercise the actual JSX handlers and Solid effects with lazy props. Native
// elements and Shelter's visual components are represented as inspectable nodes.
const { code } = transformSync(uiSource, {
  babelrc: false, configFile: false, parserOpts: { plugins: ["jsx"] },
  plugins: [({ types: t }) => ({ visitor: {
    JSXElement: { exit(path) {
      const opening = path.node.openingElement;
      const tag = opening.name.name;
      const component = /^[A-Z]/.test(tag) ? t.identifier(tag) : t.stringLiteral(tag);
      const getter = (name, value) => t.objectMethod("get", t.stringLiteral(name), [], t.blockStatement([t.returnStatement(value)]));
      const props = opening.attributes.map((attribute) => {
        const value = attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value || t.booleanLiteral(true);
        return getter(attribute.name.name, value);
      });
      const children = path.node.children.flatMap((child) => {
        if (t.isJSXText(child)) {
          const text = child.value.replace(/\s+/g, " ").trim();
          return text ? [t.stringLiteral(text)] : [];
        }
        if (t.isJSXExpressionContainer(child)) return t.isJSXEmptyExpression(child.expression) ? [] : [child.expression];
        return [child];
      });
      props.push(getter("children", children.length === 1 ? children[0] : t.arrayExpression(children)));
      path.replaceWith(t.callExpression(t.identifier("renderNode"), [component, t.objectExpression(props)]));
    } },
  } })],
});

function harness(initialRows = []) {
  const [entries, setEntries] = solid.createSignal(initialRows);
  const store = {};
  Object.defineProperty(store, "entries", { get: entries, set: setEntries });
  const blobs = new Map();
  const urls = new Set();
  const repairs = [];
  const copied = [];
  let nextUrl = 0;
  const native = (type) => (props) => ({ type, props });
  const context = vm.createContext({
    ...solid, store, entries, ARCHIVE_KEY: "entries", ARCHIVE_PAGE_SIZE: 100,
    fluxStores: { ChannelStore: { getChannel: () => null } },
    directMessageName: () => "",
    channelName: (channel) => channel?.name || "",
    archiveCount: () => entries().filter((entry) => entry.deleted).length,
    capturedCount: () => entries().length,
    formatDate: () => "date", removeArchiveEntry() {},
    ModalRoot: native("modal-root"), ModalHeader: native("modal-header"),
    ModalBody: native("modal-body"), ModalFooter: native("modal-footer"),
    TextBox: native("textbox"), Button: native("button"),
    Select: native("select"), SelectOption: native("select-option"),
    ModalSizes: { LARGE: "large" }, ButtonSizes: { MIN: "min" },
    ButtonColors: { SECONDARY: "secondary" },
    For: (props) => () => props.each?.map(props.children),
    Show: (props) => () => props.when ? props.children : props.fallback,
    photoRepairsInFlight: new Set(),
    sameJSON: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    cachePhotos: (messageId, attachments) => repairs.push({ messageId, attachments }),
    readPhotoBlob: async (key) => blobs.get(key),
    copyPhoto: async (blob) => copied.push(blob),
    Blob, console,
    URL: {
      createObjectURL() { const url = `blob:ui-${++nextUrl}`; urls.add(url); return url; },
      revokeObjectURL: (url) => urls.delete(url),
    },
    renderNode(type, props) {
      return typeof type === "function" ? solid.createComponent(type, props) : { type, props };
    },
  });
  vm.runInContext(`${code}\nglobalThis.api = { SearchablePicker, ArchiveModal, PhotoModal };`, context);
  function mount(component, props) {
    let dispose;
    let owner;
    let tree;
    solid.createRoot((cleanup) => {
      dispose = cleanup;
      owner = solid.getOwner();
      tree = solid.createComponent(context.api[component], props);
    });
    const visit = (node, result) => {
      if (typeof node === "function") return visit(node(), result);
      if (Array.isArray(node)) return node.forEach((child) => visit(child, result));
      if (node == null || typeof node === "boolean") return;
      result.push(node);
      if (node.props) visit(node.props.children, result);
    };
    const nodes = () => solid.runWithOwner(owner, () => { const result = []; visit(tree, result); return result; });
    return {
      all: (type) => nodes().filter((node) => node.type === type),
      text: () => nodes().filter((node) => typeof node === "string" || typeof node === "number").join(" "),
      close: dispose,
    };
  }
  return { mount, entries, setEntries, store, blobs, urls, repairs, copied };
}

test("duplicate picker names select distinct IDs and keep the selected label in sync", () => {
  const h = harness();
  const [value, setValue] = solid.createSignal("");
  const [options, setOptions] = solid.createSignal([
    { value: "first", label: "Same name" },
    { value: "second", label: "same name" },
    // A real name can already resemble a generated disambiguation label.
    { value: "third", label: "Same name (first)" },
  ]);
  const view = h.mount("SearchablePicker", {
    get value() { return value(); }, options, onChange: setValue,
    id: "picker", placeholder: "All servers", ariaLabel: "Server",
  });
  const labels = view.all("option").map((node) => node.props.value);
  assert.equal(new Set(labels.map((label) => label.toLowerCase())).size, 3);
  const input = view.all("input")[0];
  for (const [index, expected] of ["first", "second", "third"].entries()) {
    input.props.onInput({ currentTarget: { value: labels[index] } });
    assert.equal(value(), expected);
    assert.equal(input.props.value, labels[index]);
  }
  setValue("second");
  setOptions([{ value: "second", label: "Renamed server" }]);
  assert.equal(input.props.value, "Renamed server");
  view.close();
});

test("picker option refreshes preserve a draft while selection changes still update the input", () => {
  const h = harness();
  const [value, setValue] = solid.createSignal("first");
  const [options, setOptions] = solid.createSignal([
    { value: "first", label: "Alpha" },
    { value: "second", label: "Beta" },
  ]);
  const view = h.mount("SearchablePicker", {
    get value() { return value(); }, options, onChange: setValue,
    id: "picker", placeholder: "All servers", ariaLabel: "Server",
  });
  const input = view.all("input")[0];
  input.props.onInput({ currentTarget: { value: "Be" } });
  setOptions([
    { value: "first", label: "Alpha" },
    { value: "second", label: "Beta" },
    { value: "third", label: "Gamma" },
  ]);
  assert.equal(input.props.value, "Be", "A background archive update must not erase partial typing");
  input.props.onInput({ currentTarget: { value: "Beta" } });
  assert.equal(value(), "second");
  assert.equal(input.props.value, "Beta");
  setValue("first");
  assert.equal(input.props.value, "Alpha", "An explicit selection change should still replace the draft");
  view.close();
});

const row = (extra = {}) => ({
  id: "message", channelId: "channel-id", guildId: "guild-id", guildName: "Book club",
  channelName: "general", authorId: "user", author: "Alice", username: "alice",
  content: "Hello world", attachments: [], embeds: [], deleted: true, ...extra,
});

test("archive search finds channel names, server names, and DM recipients", () => {
  const h = harness([row(), row({ id: "dm", guildId: "", directMessageName: "Bob Smith", channelId: "dm-id" })]);
  const view = h.mount("ArchiveModal", { close() {} });
  const search = view.all("textbox")[0];
  for (const query of ["general", "BOOK CLUB", "Bob Smith", "channel-id", "Hello world"]) {
    search.props.onInput(query);
    assert.ok(view.all("article").length > 0, `Expected results for ${query}`);
  }
  search.props.onInput("unknown channel");
  assert.equal(view.all("article").length, 0);
  view.close();
});

test("edited view includes revision history and searches previous text and removed filenames", () => {
  const h = harness([row({
    id: "edited", deleted: false, editedAt: "2026-10-01T12:00:00Z", content: "Current text",
    editHistory: [{ content: "Original secret phrase", editedAt: "2026-10-01T12:00:00Z" }],
    attachments: [{ id: "file", filename: "removed-notes.txt", removedAt: "2026-10-01T12:00:00Z" }],
  }), row({ id: "deleted-only" })]);
  const view = h.mount("ArchiveModal", { close() {} });
  assert.equal(view.all("article").length, 1);
  const edited = view.all("button").find((node) => node.props.children === "Edited");
  edited.props.onClick();
  assert.equal(view.all("article").length, 1);
  assert.match(view.text(), /Current text/);
  assert.match(view.text(), /Original secret phrase/);
  assert.match(view.text(), /Attachment removed/);
  assert.equal(view.all("details").length, 1);
  const search = view.all("textbox")[0];
  for (const query of ["original secret", "removed-notes.txt", "edited"]) {
    search.props.onInput(query);
    assert.equal(view.all("article").length, 1);
  }
  search.props.onInput("absent text");
  assert.equal(view.all("article").length, 0);
  view.close();
});

test("metadata-only attachment history is visible in Edited and All archived", () => {
  const h = harness([row({ deleted: false, attachments: [{ id: "file", filename: "notes.txt", removedAt: "2026-10-01T12:00:00Z" }] })]);
  const view = h.mount("ArchiveModal", { close() {} });
  assert.equal(view.all("article").length, 0);
  view.all("button").find((node) => node.props.children === "Edited").props.onClick();
  assert.equal(view.all("article").length, 1);
  view.all("button").find((node) => node.props.children === "All archived").props.onClick();
  assert.equal(view.all("article").length, 1);
  view.close();
});

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test("an open photo modal follows a repaired blob and releases its new URL on close", async () => {
  const initialAttachment = { id: "photo", filename: "photo.png", blobKey: "missing" };
  const h = harness([row({ attachments: [initialAttachment] })]);
  const view = h.mount("PhotoModal", { attachment: initialAttachment, messageId: "message", close() {} });
  await settle();
  assert.equal(h.repairs.length, 1, "Missing stored data should start the existing repair path");
  assert.equal(h.entries()[0].attachments[0].blobKey, undefined);
  const saved = new Blob(["repaired photo"], { type: "image/png" });
  h.blobs.set("repaired", saved);
  h.setEntries([row({ attachments: [{ ...initialAttachment, blobKey: "repaired" }] })]);
  await settle();
  assert.equal(view.all("img")[0]?.props.src, "blob:ui-1");
  assert.equal(initialAttachment.blobKey, "missing", "The modal was opened with the stale attachment object");
  const copyButton = view.all("button").find((node) => node.props.children === "Copy image");
  assert.equal(copyButton.props.disabled, false);
  await copyButton.props.onClick();
  assert.equal(h.copied[0], saved);
  view.close();
  assert.equal(h.urls.size, 0);
});

test("a failed missing-photo repair shows unavailable instead of loading forever", async () => {
  const attachment = { id: "photo", filename: "photo.png", blobKey: "missing" };
  const h = harness([row({ attachments: [attachment] })]);
  const view = h.mount("PhotoModal", { attachment, messageId: "message", close() {} });
  await settle();
  h.setEntries([row({ attachments: [{ id: "photo", filename: "photo.png", photoUnavailable: true }] })]);
  assert.match(view.text(), /Archived photo is unavailable/);
  assert.doesNotMatch(view.text(), /Loading archived photo/);
  view.close();
});
