import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { config } from "../src/config.js";

/**
 * The extension also has to boot on Android.
 *
 * Chromium browsers that run MV3 extensions on Android (Quetta, Lemur, …) omit
 * desktop-only APIs. Registering a listener on a missing one throws while the
 * service worker is *starting*, which takes the whole extension down — and the
 * worker is the only path content scripts have to the backend, so autofill dies
 * with it. That failure is invisible until you're holding a phone, so it gets a
 * test instead.
 */

const BACKGROUND_SRC = fs.readFileSync(path.join(config.extensionDir, "background.js"), "utf8");

type Listener = (...args: unknown[]) => unknown;

interface FakeChrome {
  registered: Record<string, Listener[]>;
  contextMenusCreated: unknown[];
  chrome: Record<string, unknown>;
}

/** A `chrome` object exposing only the named APIs, recording what registers. */
function fakeChrome(apis: string[]): FakeChrome {
  const registered: Record<string, Listener[]> = {};
  const contextMenusCreated: unknown[] = [];
  const event = (name: string) => ({
    addListener: (fn: Listener) => {
      (registered[name] ??= []).push(fn);
    },
  });

  const all: Record<string, unknown> = {
    runtime: {
      onMessage: event("runtime.onMessage"),
      onInstalled: event("runtime.onInstalled"),
      onStartup: event("runtime.onStartup"),
      lastError: null,
      sendMessage: () => undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      // Prefill-ahead parks jobId↔tabId in session storage and listens for the
      // tab closing. Both exist on Android; omit them and the worker throws at boot.
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
    tabs: {
      query: () => undefined,
      update: async () => undefined,
      onUpdated: event("tabs.onUpdated"),
      onRemoved: event("tabs.onRemoved"),
    },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText: () => undefined, setBadgeBackgroundColor: () => undefined },
    alarms: {
      onAlarm: event("alarms.onAlarm"),
      get: async () => undefined,
      create: async () => undefined,
      clear: async () => undefined,
    },
    contextMenus: {
      onClicked: event("contextMenus.onClicked"),
      create: (spec: unknown) => contextMenusCreated.push(spec),
    },
    sidePanel: { open: async () => undefined },
    windows: { create: async () => ({ id: 1, tabs: [{ id: 2 }] }), remove: async () => undefined },
    webNavigation: { getAllFrames: async () => [] },
    permissions: { contains: async () => true, request: async () => true },
  };

  const chrome: Record<string, unknown> = {};
  for (const api of apis) {
    if (!(api in all)) throw new Error(`test bug: unknown api "${api}"`);
    chrome[api] = all[api];
  }
  return { registered, contextMenusCreated, chrome };
}

function boot(apis: string[]): FakeChrome {
  const f = fakeChrome(apis);
  const sandbox = {
    chrome: f.chrome,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    console: { log: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Math,
    Promise,
    Map,
    Set,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Error,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    TextDecoder,
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SRC, sandbox, { filename: "background.js" });
  return f;
}

/** What an Android Chromium build gives you: no context menus, alarms, side
 *  panel, or second window. */
const ANDROID_APIS = ["runtime", "storage", "tabs", "scripting", "action", "permissions"];
const DESKTOP_APIS = [...ANDROID_APIS, "alarms", "contextMenus", "sidePanel", "windows", "webNavigation"];

describe("extension background worker — Android boot", () => {
  it("starts without the desktop-only APIs", () => {
    expect(() => boot(ANDROID_APIS)).not.toThrow();
  });

  it("still registers the message handler — content scripts reach the backend through it", () => {
    const f = boot(ANDROID_APIS);
    expect(f.registered["runtime.onMessage"]).toHaveLength(1);
  });

  it("does not register listeners on APIs that aren't there", () => {
    const f = boot(ANDROID_APIS);
    expect(f.registered["contextMenus.onClicked"]).toBeUndefined();
    expect(f.registered["alarms.onAlarm"]).toBeUndefined();
  });

  it("survives onInstalled, which is where the context menus are built", async () => {
    const f = boot(ANDROID_APIS);
    const onInstalled = f.registered["runtime.onInstalled"]?.[0];
    expect(onInstalled).toBeTypeOf("function");
    await expect(Promise.resolve(onInstalled!())).resolves.not.toThrow();
    expect(f.contextMenusCreated).toEqual([]);
  });

  it("keeps every desktop feature where the APIs exist", async () => {
    const f = boot(DESKTOP_APIS);
    expect(f.registered["contextMenus.onClicked"]).toHaveLength(1);
    expect(f.registered["alarms.onAlarm"]).toHaveLength(1);
    await Promise.resolve(f.registered["runtime.onInstalled"]![0]!());
    // Copilot, field-helper, capture, mark-applied, scan-list, capture-selection.
    expect(f.contextMenusCreated).toHaveLength(6);
  });
});
