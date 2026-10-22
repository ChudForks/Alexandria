import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const core = [
  section("function asString(", "function archiveActivityTime("),
  section("function storedIdList(", "function isActiveMessageLocation("),
  section("function shouldIgnoreMessage(", "function sameJSON("),
  section("function captureDeletedMessage(", "function messageFromPayload("),
].join("\n");

function harness(settings = {}, options = {}) {
  const store = { archiveSchemaVersion: 2, ...settings };
  const channels = new Map([
    ["100", { id: "100", guild_id: "10", parent_id: "90" }],
    ["101", { id: "101", guild_id: "10", parent_id: "100" }],
    ["90", { id: "90", guild_id: "10" }],
    ["200", { id: "200" }],
  ]);
  const users = new Map([["bot", { id: "bot", bot: true }]]);
  const pendingMessages = new Map();
  const archive = [];
  const effects = { deleted: 0, recovery: 0, lookups: 0 };
  const context = vm.createContext({
    store, ARCHIVE_KEY: "entries", ARCHIVE_SCHEMA_VERSION: 2,
    fluxStores: {
      ChannelStore: { getChannel(id) { effects.lookups++; return channels.get(id); } },
      UserStore: { getCurrentUser: () => options.currentUser ?? { id: "self" }, getUser: (id) => users.get(id) },
      SelectedChannelStore: { getChannelId: () => "100" },
    },
    location: { pathname: "/channels/10/100" },
    normaliseAttachment: (value) => value, normaliseEmbed: (value) => value,
    channelName: () => "channel", directMessageName: () => "DM",
    pendingMessages, historyEntry: () => null, entries: () => archive,
    messageFromStore: () => null,
    markDeleted: () => { effects.deleted++; return true; },
    recoverHistoryDeletion: () => effects.recovery++,
  });
  vm.runInContext(`${section("store[ARCHIVE_KEY] ??=", "let launcherHost;")}\n${core}`, context);
  return { store, channels, users, pendingMessages, archive, effects, context };
}

const message = (extra = {}) => ({
  id: "message", channel_id: "100", guild_id: "10", content: "hello",
  author: { id: "123", username: "alice" }, attachments: [], embeds: [], ...extra,
});

test("capture exclusions default off and preserve existing capture scope", () => {
  const h = harness();
  assert.equal(h.store.ignoreBots, false);
  assert.equal(h.store.ignoreSelf, false);
  assert.equal(h.context.shouldCaptureMessage(message({ author: { id: "self", bot: true } })), true);
  for (const key of ["ignoredUserIds", "ignoredChannelIds", "ignoredGuildIds"]) assert.equal(h.store[key].length, 0);
  h.store.captureMode = "selected";
  assert.equal(h.context.shouldCaptureMessage(message()), false);
  h.store.selectedGuildIds = ["10"];
  assert.equal(h.context.shouldCaptureMessage(message()), true);
  h.store.ignoredGuildIds = ["10"];
  h.store.activeMode = true;
  assert.equal(h.context.shouldCaptureMessage(message()), false, "Active scope must not bypass exclusions");
});

test("user and server IDs match complete comma/whitespace-delimited values", () => {
  const h = harness({ ignoredUserIds: " 1234, 456\n789 " });
  assert.equal(h.context.shouldCaptureMessage(message()), true, "123 must not match 1234");
  for (const id of ["1234", "456", "789"]) {
    assert.equal(h.context.shouldIgnoreMessage(message({ author: { id } })), true);
  }
  h.store.ignoredUserIds = ["123"];
  assert.equal(h.context.shouldIgnoreMessage({ authorId: "123", channelId: "100" }), true);
  assert.equal(h.context.shouldIgnoreMessage({ author_id: "123", channelId: "100" }), true);
  h.store.ignoredUserIds = [];
  h.store.ignoredGuildIds = "100, 20";
  assert.equal(h.context.shouldIgnoreMessage(message()), false);
  h.store.ignoredGuildIds = ["10"];
  assert.equal(h.context.shouldIgnoreMessage({ channelId: "100" }), true, "Use the channel store when guild_id is omitted");
});

test("channel exclusions include threads and category descendants, with exact IDs", () => {
  const h = harness({ ignoredChannelIds: ["1000"] });
  assert.equal(h.context.shouldIgnoreMessage(message()), false);
  h.store.ignoredChannelIds = ["100"];
  assert.equal(h.context.shouldIgnoreMessage({ channel_id: "101" }), true);
  h.store.ignoredChannelIds = "90";
  assert.equal(h.context.shouldIgnoreMessage({ channelId: "101" }), true);
  h.store.ignoredChannelIds = ["200"];
  assert.equal(h.context.shouldIgnoreMessage({ authorId: "123" }, "200"), true, "Fallback DM IDs are excluded exactly");
  assert.equal(h.context.shouldIgnoreMessage({ channel_id: "999" }), false, "Missing channel data is tolerated");
  h.channels.set("300", { parent_id: "301" });
  h.channels.set("301", { parent_id: "300" });
  const before = h.effects.lookups;
  assert.equal(h.context.shouldIgnoreMessage({ channelId: "300" }), false);
  assert.ok(h.effects.lookups - before <= 3, "A parent cycle terminates after visiting each channel");
});

test("bot and self filters normalize raw, archived and partial author data", () => {
  const h = harness({ ignoreBots: true, ignoreSelf: true });
  assert.equal(h.context.shouldIgnoreMessage(message({ author: { id: "self" } })), true);
  assert.equal(h.context.shouldIgnoreMessage({ authorId: "self" }), true);
  assert.equal(h.context.shouldIgnoreMessage(message({ author: { id: "bot", bot: true } })), true);
  assert.equal(h.context.shouldIgnoreMessage({ authorId: "bot", authorBot: true }), true);
  assert.equal(h.context.shouldIgnoreMessage({ authorId: "bot" }), true, "UserStore supplies omitted bot data");
  assert.equal(h.context.shouldIgnoreMessage({ author: { id: "bot", bot: false }, authorBot: true }), false);
  assert.equal(h.context.shouldIgnoreMessage({ id: "partial" }), false, "Unknown authors are not mistaken for self");
  const original = h.context.toArchiveEntry(message({ author: { id: "bot", username: "helper", bot: true } }));
  assert.equal(original.authorBot, true);
  const edited = h.context.toArchiveEntry({ id: "message", content: "edit" }, original);
  assert.equal(edited.authorId, "bot");
  assert.equal(edited.authorBot, true);
  assert.equal(h.context.shouldIgnoreMessage(edited), true);
  assert.equal(h.context.toArchiveEntry(message({ author: { id: "bot", username: "helper", bot: false } }), original).authorBot, false);
});

test("new exclusions prevent deletion retention for already captured snapshots", () => {
  for (const location of ["pending", "archive"]) {
    const h = harness();
    const captured = h.context.toArchiveEntry(message({ author: { id: "bot", username: "helper", bot: true } }));
    if (location === "pending") h.pendingMessages.set("message", captured);
    else h.archive.push(captured);
    h.store.ignoreBots = true;
    assert.equal(h.context.captureDeletedMessage("message", "100", { id: "message", channel_id: "100" }), false);
    assert.equal(h.effects.deleted, 0, `The ${location} snapshot must not reach archive mutation`);
    assert.equal(h.effects.recovery, 0);
  }
});

const require = createRequire(import.meta.url);
const buildDependencies = createRequire(require.resolve("@uwu/lune/package.json"));
const { transformSync } = buildDependencies("@babel/core");
const shelterDependencies = createRequire(require.resolve("@uwu/shelter-defs/package.json"));
const solid = shelterDependencies(join(dirname(shelterDependencies.resolve("solid-js/package.json")), "dist", "solid.cjs"));
const { code } = transformSync(section("function CaptureExclusionSettings(", "export const settings"), {
  babelrc: false, configFile: false, parserOpts: { plugins: ["jsx"] },
  plugins: [({ types: t }) => ({ visitor: { JSXElement: { exit(path) {
    const opening = path.node.openingElement;
    const tag = opening.name.name;
    const getter = (name, value) => t.objectMethod("get", t.stringLiteral(name), [], t.blockStatement([t.returnStatement(value)]));
    const props = opening.attributes.map((attribute) => getter(attribute.name.name,
      attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value || t.booleanLiteral(true)));
    const children = path.node.children.flatMap((child) => {
      if (t.isJSXText(child)) return child.value.trim() ? [t.stringLiteral(child.value.trim())] : [];
      if (t.isJSXExpressionContainer(child)) return t.isJSXEmptyExpression(child.expression) ? [] : [child.expression];
      return [child];
    });
    props.push(getter("children", children.length === 1 ? children[0] : t.arrayExpression(children)));
    path.replaceWith(t.callExpression(t.identifier("renderNode"), [/^[A-Z]/.test(tag) ? t.identifier(tag) : t.stringLiteral(tag), t.objectExpression(props)]));
  } } } })],
});

test("Shelter exclusion text inputs accept strings and persist normalized IDs", () => {
  const h = harness({ ignoredUserIds: ["123"] });
  const textboxes = new Map();
  const switches = new Map();
  let refreshes = 0;
  Object.assign(h.context, {
    createSignal: solid.createSignal, createEffect: solid.createEffect,
    refreshHistoryCapture: () => refreshes++,
    TextBox(props) { textboxes.set(props.id, props); return props; },
    SwitchItem(props) { switches.set(props.children.trim(), props); return props; },
    renderNode(type, props) { return typeof type === "function" ? solid.createComponent(type, props) : { type, children: props.children }; },
  });
  vm.runInContext(`${code}\nglobalThis.renderExclusions = CaptureExclusionSettings;`, h.context);
  let dispose;
  solid.createRoot((cleanup) => { dispose = cleanup; solid.createComponent(h.context.renderExclusions, {}); });
  for (const [id, key] of [["users", "ignoredUserIds"], ["channels", "ignoredChannelIds"], ["guilds", "ignoredGuildIds"]]) {
    const textbox = textboxes.get(`alexandria-ignored-${id}`);
    textbox.onInput(" 123, 456\n123 789 ");
    assert.deepEqual([...h.store[key]], ["123", "456", "789"]);
    assert.equal(textbox.value, " 123, 456\n123 789 ");
    textbox.onInput("");
    assert.equal(h.store[key].length, 0);
  }
  for (const [label, key] of [["Ignore bot messages", "ignoreBots"], ["Ignore your own messages", "ignoreSelf"]]) {
    const control = switches.get(label);
    for (const enabled of [true, false, true]) {
      control.onChange(enabled);
      assert.equal(control.checked, enabled);
      assert.equal(h.store[key], enabled);
    }
  }
  assert.equal(refreshes, 12);
  dispose();
});
