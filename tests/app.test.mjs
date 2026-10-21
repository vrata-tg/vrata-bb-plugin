import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("model onboarding consumes the real slot payload and submits a supported effort after a model switch", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  let view;
  const previous = new Map();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MutationObserver"]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  }
  t.after(async () => {
    view?.unmount();
    await new Promise((resolve) => setImmediate(resolve));
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const app = await loadPluginApp(() => import("../dist/tests/app.js"));
  const slot = app.pendingInteractions.find(({ id }) => id === "model");
  const submitted = [];
  view = renderSlot(slot, {
    interaction: {
      id: "interaction-model", threadId: "thread-model", title: "Choose model",
      payload: { models: [
        { id: "reasoning", name: "Reasoning", reasoningLevels: ["none", "high", "max"] },
        { id: "text", name: "Text", reasoningLevels: ["none"] },
      ] },
    },
    submit: async (value) => { submitted.push(value); },
  });
  const selectors = view.getAllByRole("combobox");
  assert.equal(selectors.length, 2);
  assert.deepEqual([...selectors[0].options].map(({ value }) => value), ["reasoning", "text"]);
  fireEvent.change(selectors[1], { target: { value: "max" } });
  fireEvent.click(view.getByRole("button"));
  await waitFor(() => assert.deepEqual(submitted[0], { modelId: "reasoning", reasoningLevel: "max" }));
  await waitFor(() => assert.equal(view.getByRole("button").disabled, false));
  fireEvent.change(selectors[0], { target: { value: "text" } });
  assert.equal(view.getAllByRole("combobox").length, 1);
  fireEvent.click(view.getByRole("button"));
  await waitFor(() => assert.deepEqual(submitted[1], { modelId: "text", reasoningLevel: "none" }));
});
