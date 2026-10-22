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
// Use Solid's real client reactivity, not its default Node/SSR implementation.
const solid = shelterDependencies(join(dirname(shelterDependencies.resolve("solid-js/package.json")), "dist", "solid.cjs"));
const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const settingsStart = source.includes("function SettingsSwitch(")
  ? source.indexOf("function SettingsSwitch(") : source.indexOf("export const settings");
const settingsSource = source.slice(settingsStart, source.indexOf("export function onUnload")).replace("export const settings", "const settings");

// Preserve Solid-style lazy prop getters while exercising the actual settings
// JSX, event handlers and signals. DOM/Shelter widgets are modeled at the edge;
// no Discord connection or browser is needed for these controlled-input tests.
const { code } = transformSync(settingsSource, {
  babelrc: false, configFile: false, parserOpts: { plugins: ["jsx"] },
  plugins: [({ types: t }) => ({ visitor: {
    JSXElement: { exit(path) {
      const opening = path.node.openingElement;
      const tag = opening.name.name;
      const component = /^[A-Z]/.test(tag) ? t.identifier(tag) : t.stringLiteral(tag);
      const getter = (name, value) => t.objectMethod("get", t.identifier(name), [], t.blockStatement([t.returnStatement(value)]));
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

const labels = {
  captureEnabled: "Capture messages",
  experimentalHistoryEnabled: "Experimental older-message capture",
  showButton: "Show Alexandria launcher",
  photoBackfillEnabled: "Backfill archived photos",
  logEdits: "Log message edits",
  logDeletedAttachments: "Preserve removed attachments",
};

function settingsHarness(saved = {}, reactiveStorage = false) {
  const initial = { captureEnabled: true, experimentalHistoryEnabled: false, showButton: true, photoBackfillEnabled: false, logEdits: true, logDeletedAttachments: true, ...saved };
  const fields = new Map(Object.entries(initial).map(([key, value]) => [key, solid.createSignal(value)]));
  const store = reactiveStorage ? new Proxy(initial, {
    get: (target, key) => fields.get(key)?.[0]() ?? target[key],
    set: (target, key, value) => { target[key] = value; fields.get(key)?.[1](value); return true; },
  }) : initial;
  const effects = { history: 0, experimental: [], backfill: 0 };

  function openSettings() {
    const switches = new Map();
    const context = vm.createContext({
      store, createSignal: solid.createSignal, createEffect: solid.createEffect,
      SwitchItem(props) {
        // Shelter's controlled Switch memoizes checked and calls onChange
        // with its inverse. A stale memo makes every click send the same value.
        const checked = solid.createMemo(() => props.checked);
        const node = { type: "switch", checked, note: props.note, click: () => props.onChange(!checked()) };
        switches.set(props.children, node);
        return node;
      },
      CaptureScopeSettings: () => ({ type: "scope" }),
      CaptureExclusionSettings: () => ({ type: "exclusions" }),
      Button: () => ({ type: "button" }), ButtonSizes: { MIN: "min" }, ButtonColors: { CRITICAL_SECONDARY: "critical" },
      refreshHistoryCapture: () => effects.history++,
      setExperimentalHistoryEnabled: (value) => { store.experimentalHistoryEnabled = Boolean(value); effects.experimental.push(Boolean(value)); },
      backfillArchivedPhotos: () => effects.backfill++,
      storageBytes: () => 0, formatBytes: () => "0 B", openArchive() {}, clearArchive() {},
      renderNode(type, props) {
        if (typeof type === "function") return solid.createComponent(type, props);
        return { type, children: props.children };
      },
    });
    vm.runInContext(`${code}\nglobalThis.settingsComponent = settings;`, context, { filename: "alexandria-settings.jsx" });
    let dispose;
    solid.createRoot((cleanup) => {
      dispose = cleanup;
      solid.createComponent(context.settingsComponent, {});
    });
    return { switches, close: () => dispose() };
  }
  return { store, effects, openSettings };
}

for (const [key, label] of Object.entries(labels)) {
  for (const initial of [false, true]) {
    test(`${label} toggles repeatedly from ${initial ? "on" : "off"} and persists on reopening`, () => {
      // A snapshot/non-reactive storage boundary reproduces the reported stuck
      // switches. The UI must update immediately without a storage notification.
      const h = settingsHarness({ [key]: initial });
      const modal = h.openSettings();
      const control = modal.switches.get(label);
      assert.equal(control.checked(), initial);
      for (const next of [!initial, initial, !initial]) {
        control.click();
        assert.equal(control.checked(), next, "The visible controlled switch must update immediately");
        assert.equal(h.store[key], next, "The selected value must also be saved");
      }
      modal.close();
      const reopened = h.openSettings();
      assert.equal(reopened.switches.get(label).checked(), !initial);
      reopened.close();
    });
  }
}

test("settings toggles preserve their capture, cache and photo-backfill side effects", () => {
  const h = settingsHarness();
  const modal = h.openSettings();
  modal.switches.get(labels.captureEnabled).click();
  modal.switches.get(labels.captureEnabled).click();
  assert.equal(h.effects.history, 2);
  modal.switches.get(labels.experimentalHistoryEnabled).click();
  modal.switches.get(labels.experimentalHistoryEnabled).click();
  assert.deepEqual(h.effects.experimental, [true, false]);
  modal.switches.get(labels.photoBackfillEnabled).click();
  modal.switches.get(labels.photoBackfillEnabled).click();
  assert.equal(h.effects.backfill, 1);
  modal.close();
});

test("switches also follow externally changed reactive storage values", () => {
  const h = settingsHarness({}, true);
  const modal = h.openSettings();
  for (const [key, label] of Object.entries(labels)) {
    const next = !h.store[key];
    h.store[key] = next;
    assert.equal(modal.switches.get(label).checked(), next);
    modal.switches.get(label).click();
    assert.equal(h.store[key], !next);
  }
  modal.close();
});
