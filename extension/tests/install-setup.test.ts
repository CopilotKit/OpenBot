import { afterEach, beforeEach, expect, test } from "bun:test";
import { installSetup, SETUP_PAGE } from "../src/background/setup";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake = installChromeFake({ manifestVersion: "0.2.0" });
});
afterEach(() => {
  fake.uninstall();
});

test("a fresh install opens the setup page once, in front, to ask for the microphone", async () => {
  installSetup();
  expect(fake.calls).toContain("runtime.onInstalled.addListener");
  fake.fireInstalled("install");
  await settle();
  expect(SETUP_PAGE).toBe("setup.html");
  expect(fake.opened).toEqual([chrome.runtime.getURL("setup.html")]);
  expect([...fake.tabs.values()].map((tab) => tab.active)).toEqual([true]);
});

test("an update, a browser update and a service worker restart open nothing", async () => {
  installSetup();
  fake.fireInstalled("update");
  fake.fireInstalled("chrome_update");
  fake.fireInstalled("shared_module_update");
  fake.restartServiceWorker();
  installSetup();
  fake.fireStartup();
  await settle();
  expect(fake.opened).toEqual([]);
});
