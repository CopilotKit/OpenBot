import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "../desktop/node_modules/@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "../desktop/node_modules/@testing-library/react";
import userEvent from "../desktop/node_modules/@testing-library/user-event";
import { clearMocks, mockIPC } from "../desktop/node_modules/@tauri-apps/api/mocks";
import { createElement } from "../desktop/node_modules/react";

const calls: {command: string; args: unknown}[] = [];
let permitted = true;
let failure: string | null = null;
const { RuntimeUpdates } = await import("../desktop/src/RuntimeUpdates");
beforeAll(() => GlobalRegistrator.register());
beforeEach(() => mockIPC(async (command, args) => {
  calls.push({command,args});
  if(failure) throw failure;
  if(command==="check_runtime_update") return {allowed:permitted,reasons:permitted?[]:["wrong distribution"],fromVersion:"v0.2.0",toVersion:"v0.3.0",requiresDowntime:true,recovery:"restart-previous"};
  return {version:"v0.3.0"};
}));
afterEach(() => { clearMocks(); cleanup(); calls.length=0; permitted=true; failure=null; });
afterAll(() => GlobalRegistrator.unregister());
function setup() {
  let applied=0;
  const view=render(createElement(RuntimeUpdates,{root:"/customer/openbot",onApply:async()=>{applied++;return {version:"v0.3.0"};}}));
  return {view,applied:()=>applied};
}
async function check(view: ReturnType<typeof render>) {
  await userEvent.setup({document:view.container.ownerDocument}).type(view.getByLabelText("Release tag"),"v0.3.0");
  fireEvent.click(view.getByRole("button",{name:"Check runtime update"}));
  await waitFor(()=>expect(calls.at(-1)?.command).toBe("check_runtime_update"));
}
test("desktop updates are explicit and stage before acknowledged apply",async()=>{
  const {view,applied}=setup(); expect(calls).toEqual([]);
  await check(view);
  fireEvent.click(await view.findByRole("button",{name:"Stage runtime update"}));
  const apply=await view.findByRole("button",{name:"Apply update and restart"});
  expect(apply.hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("checkbox")); fireEvent.click(apply);
  await waitFor(()=>expect(applied()).toBe(1));
  expect(calls.map(c=>c.command)).toEqual(["check_runtime_update","stage_runtime_update"]);
  expect(calls[1]?.args).toEqual({root:"/customer/openbot",version:"v0.3.0"});
  expect(view.getByText(/Signed desktop shell updates are not configured/)).toBeTruthy();
});
test("a refused plan cannot stage or apply and changing target invalidates the plan",async()=>{
  permitted=false; const {view,applied}=setup(); await check(view);
  expect(await view.findByText("wrong distribution")).toBeTruthy();
  expect(view.queryByRole("button",{name:"Stage runtime update"})).toBeNull(); expect(applied()).toBe(0);
  await userEvent.setup({document:view.container.ownerDocument}).clear(view.getByLabelText("Release tag"));
  await userEvent.setup({document:view.container.ownerDocument}).type(view.getByLabelText("Release tag"),"v0.4.0");
  expect(view.queryByText("wrong distribution")).toBeNull();
});
test("baseline verification is a separate explicit action and failures stay visible",async()=>{
  const {view}=setup(); failure="pinned publisher has no release manifest";
  fireEvent.click(view.getByRole("button",{name:"Verify installed release baseline"}));
  expect(await view.findByText(failure)).toBeTruthy();
  expect(calls.map(c=>c.command)).toEqual(["establish_runtime_baseline"]);
});
