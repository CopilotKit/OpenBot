import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  SocketControl,
  SocketRecord,
  StreamControl,
  StreamRecord,
} from "./appContract";
import { StreamPanel } from "./StreamPanel";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function fakeStreams(list: StreamRecord[]) {
  const listeners = new Set<() => void>();
  const push = mock();
  const end = mock();
  const control: StreamControl = {
    streams: () => list,
    push,
    end,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    control,
    push,
    end,
    add(record: StreamRecord) {
      list.push(record);
      for (const listener of listeners) listener();
    },
  };
}

function fakeSockets(list: SocketRecord[]) {
  const send = mock(
    (match: string, _data: unknown) =>
      list.filter((s) => s.state === "open" && s.url.includes(match)).length,
  );
  const control: SocketControl = {
    sockets: () => list,
    send,
    close: () => 0,
    onChange: () => () => {},
  };
  return { control, send };
}

function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

function section(view: ReturnType<typeof render>, name: string) {
  const heading = view.getByRole("heading", { name });
  return within(heading.closest("section") as HTMLElement);
}

/** Opens the Agent list of the Streams section and picks the agent with that name. */
async function pickAgent(box: ReturnType<typeof within>, name: string) {
  const person = userEvent.setup({ document });
  await person.click(box.getByRole("combobox", { name: "Agent" }));
  await person.click(
    await within(document.body).findByRole("option", { name }),
  );
}

const OPEN_STREAM: StreamRecord = {
  id: 1,
  agent: "default",
  path: "/api/copilotkit",
  open: true,
  sent: 3,
};

test("lists streams and sends an event array to the picked agent", async () => {
  const streams = fakeStreams([OPEN_STREAM]);
  const view = render(<StreamPanel streams={streams.control} sockets={null} />);
  const box = section(view, "Streams");
  const row = box.getByTestId("stream");
  expect(row.textContent).toContain("default");
  expect(row.textContent).toContain("/api/copilotkit");
  expect(row.textContent).toContain("Open");
  expect(row.textContent).toContain("3 sent");
  await pickAgent(box, "default");
  const events = [
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "TEXT_MESSAGE_END", messageId: "m1" },
  ];
  edit(box.getByLabelText("Event (JSON)"), JSON.stringify(events));
  fireEvent.click(box.getByText("Send"));
  expect(streams.push).toHaveBeenCalledWith("default", events);
});

test("one event is sent as a list, to all agents by default", () => {
  const streams = fakeStreams([]);
  const view = render(<StreamPanel streams={streams.control} sockets={null} />);
  const box = section(view, "Streams");
  edit(box.getByLabelText("Event (JSON)"), '{"type":"RUN_STARTED"}');
  fireEvent.click(box.getByText("Send"));
  expect(streams.push).toHaveBeenCalledWith("*", [{ type: "RUN_STARTED" }]);
});

test("bad JSON or an event without a type shows the error and sends nothing", () => {
  const streams = fakeStreams([OPEN_STREAM]);
  const view = render(<StreamPanel streams={streams.control} sockets={null} />);
  const box = section(view, "Streams");
  edit(box.getByLabelText("Event (JSON)"), "{nope");
  fireEvent.click(box.getByText("Send"));
  expect(box.getByRole("alert").textContent).toBe(
    "Write an AG-UI event with a type, or a list of them.",
  );
  edit(box.getByLabelText("Event (JSON)"), '[{"type":"RUN_STARTED"},{}]');
  fireEvent.click(box.getByText("Send"));
  expect(box.getByRole("alert")).not.toBeNull();
  expect(streams.push).not.toHaveBeenCalled();
});

test("End the stream ends the picked agent", async () => {
  const streams = fakeStreams([OPEN_STREAM]);
  const view = render(<StreamPanel streams={streams.control} sockets={null} />);
  const box = section(view, "Streams");
  await pickAgent(box, "default");
  fireEvent.click(box.getByText("End the stream"));
  expect(streams.end).toHaveBeenCalledWith("default");
});

test("a stream opened after render shows in the list and the agents", async () => {
  const streams = fakeStreams([]);
  const view = render(<StreamPanel streams={streams.control} sockets={null} />);
  const box = section(view, "Streams");
  expect(box.queryAllByTestId("stream")).toHaveLength(0);
  act(() => streams.add(OPEN_STREAM));
  expect(box.queryAllByTestId("stream")).toHaveLength(1);
  await userEvent
    .setup({ document })
    .click(box.getByRole("combobox", { name: "Agent" }));
  const options = await within(document.body).findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["* (all)", "default"]);
});

test("socket send shows the count and parses JSON", () => {
  const sockets = fakeSockets([
    {
      id: 1,
      url: "ws://127.0.0.1/api/channels/a",
      state: "open",
      sent: [],
      received: 2,
    },
    {
      id: 2,
      url: "ws://127.0.0.1/api/channels/b",
      state: "open",
      sent: [],
      received: 0,
    },
  ]);
  const view = render(<StreamPanel streams={null} sockets={sockets.control} />);
  const box = section(view, "Sockets");
  expect(box.getAllByTestId("socket")[0]?.textContent).toContain("2 received");
  edit(box.getByLabelText("Address contains"), "channels");
  edit(box.getByLabelText("Message"), '{"kind":"ping"}');
  fireEvent.click(box.getByText("Send"));
  expect(sockets.send).toHaveBeenCalledWith("channels", { kind: "ping" });
  expect(box.getByRole("status").textContent).toBe("Sent to 2 sockets.");
  edit(box.getByLabelText("Address contains"), "nowhere");
  edit(box.getByLabelText("Message"), "hello");
  fireEvent.click(box.getByText("Send"));
  expect(sockets.send).toHaveBeenLastCalledWith("nowhere", "hello");
  expect(box.getByRole("status").textContent).toBe("Sent to 0 sockets.");
});

test("with nothing open, the sections say so", () => {
  const view = render(<StreamPanel streams={null} sockets={null} />);
  expect(view.getByText("No streams yet.")).not.toBeNull();
  expect(view.getByText("No sockets yet.")).not.toBeNull();
});
