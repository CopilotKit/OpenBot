import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, View } from "react-native";
import {
  type ComputerControl,
  ORGANIZATION_ID,
  organizationAddress,
} from "../src/api";
import {
  getComputerControl,
  getComputerScreenshot,
  releaseComputerControl,
  requestComputerControl,
  sendComputerHumanInput,
  supplyComputerSecret,
  takeComputerControl,
} from "../src/api/generated/computers/computers";
import type { ComputerHumanInput } from "../src/api/generated/model";
import { authClient, serverUrl } from "../src/auth";
import { cn, Notice, ScrollScreen, Text } from "../src/components";
import { clientHeaders } from "../src/release";
import { useAction } from "../src/use-action";

type Frame = { uri: string; width: number; height: number };

/** The Bot's screen, live: the API's `computers/{botId}/screen` socket (api/asyncapi.yaml). */
const screenSocketPath = (botId: string) =>
  organizationAddress(`/computers/${encodeURIComponent(botId)}/screen`);

/**
 * The live screen: frames from the same authenticated stream the web view uses, with a screenshot
 * poll until the stream delivers (or when it cannot connect).
 */
function useLiveFrame(botId: string, enabled: boolean) {
  const [frame, setFrame] = useState<Frame>();
  const [problem, setProblem] = useState("");
  const streaming = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let socket: WebSocket | undefined;
    streaming.current = false;
    void (async () => {
      const token = await authClient.getAccessToken();
      // Which organization could not be read: the screenshot poll below says why.
      const path = await screenSocketPath(botId).catch(() => undefined);
      if (closed || path === undefined) return;
      const url = `${serverUrl.replace(/^http/, "ws")}${path}`;
      // React Native's WebSocket accepts headers, which is how the access token reaches the upgrade.
      const Native = WebSocket as unknown as new (
        url: string,
        protocols: string[] | null,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      socket = new Native(url, null, {
        headers: {
          ...clientHeaders(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      socket.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        const value = message as {
          type?: unknown;
          data?: unknown;
          width?: unknown;
          height?: unknown;
          error?: unknown;
        };
        if (value.type === "error" && typeof value.error === "string") {
          setProblem(value.error);
          return;
        }
        if (value.type !== "frame" || typeof value.data !== "string") return;
        const width = typeof value.width === "number" ? value.width : 1280;
        const height = typeof value.height === "number" ? value.height : 800;
        if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192))
          return;
        streaming.current = true;
        setFrame({
          uri: `data:image/jpeg;base64,${value.data}`,
          width,
          height,
        });
      };
      socket.onclose = () => {
        streaming.current = false;
      };
    })();
    // Until frames stream, and whenever they stop, show the latest screenshot instead.
    const poll = setInterval(async () => {
      if (streaming.current || AppState.currentState !== "active") return;
      try {
        // A frame, or `ready: false` for a computer that is asleep or starting, which this does not wake.
        const value = await getComputerScreenshot(ORGANIZATION_ID, botId);
        if (closed || streaming.current || !("base64" in value)) return;
        setFrame({
          uri: `data:image/png;base64,${value.base64}`,
          width: value.width,
          height: value.height,
        });
        setProblem("");
      } catch (failure) {
        setProblem(
          failure instanceof Error
            ? failure.message
            : "The screen is not available right now.",
        );
      }
    }, 1500);
    return () => {
      closed = true;
      clearInterval(poll);
      socket?.close();
    };
  }, [botId, enabled]);
  return { frame, problem };
}

/**
 * A Bot's computer on the phone. It opens in your control: the Bot pauses at its next step while
 * you tap and type, and Return control hands it back.
 */
export default function ComputerScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [control, setControl] = useState<ComputerControl | null>(null);
  const [requestId, setRequestId] = useState("");
  const [text, setText] = useState("");
  const [secret, setSecret] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const opened = useRef(false);
  const live = useLiveFrame(botId, Boolean(session && botId));
  const driving = control?.holder === "human" && !control.transitioning;

  const readControl = useCallback(async () => {
    const state = await getComputerControl(
      ORGANIZATION_ID,
      botId,
      requestId ? { requestId } : undefined,
    );
    setControl(state);
    return state;
  }, [botId, requestId]);

  const take = useCallback(
    () =>
      action.run("take", async () => {
        const current = await readControl();
        const waiting =
          current.request?.status === "waiting" ? current.request.id : "";
        const id =
          waiting ||
          (
            await requestComputerControl(ORGANIZATION_ID, botId, {
              reason: "Opened on mobile.",
            })
          ).request?.id;
        if (!id) throw new Error("Control could not be requested.");
        setRequestId(id);
        setControl(
          await takeComputerControl(ORGANIZATION_ID, botId, { requestId: id }),
        );
      }),
    [action, botId, readControl],
  );

  // Opening the computer puts it in your control, once per visit.
  useEffect(() => {
    if (!session || !botId || opened.current) return;
    opened.current = true;
    void take();
  }, [session, botId, take]);

  useEffect(() => {
    if (!session || !botId) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active")
        void readControl().catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [session, botId, readControl]);

  // Leaving the screen hands control back rather than stranding the Bot.
  const release = useRef<() => void>(() => {});
  release.current = () => {
    if (requestId && control?.holder === "human")
      void releaseComputerControl(ORGANIZATION_ID, botId, {
        requestId,
      }).catch(() => undefined);
  };
  useEffect(() => () => release.current(), []);

  if (!session && !isPending) return <Redirect href="/" />;

  const send = (
    kind: "click" | "type" | "key" | "scroll",
    gesture: ComputerHumanInput,
  ) =>
    action.run(kind, () =>
      sendComputerHumanInput(ORGANIZATION_ID, botId, kind, gesture),
    );
  const frame = live.frame;

  return (
    <ScrollScreen className="gap-4">
      <View
        className={cn(
          "gap-1 rounded-lg border p-3",
          driving
            ? "border-success/30 bg-success/10"
            : "border-border bg-surface",
        )}
      >
        <Text variant="label" className="font-semibold">
          {!control
            ? "Checking who has control…"
            : control.transitioning
              ? "Finishing the Bot's current action before giving you control…"
              : driving
                ? "You have control. Tap the screen to click."
                : "The Bot has control."}
        </Text>
        {control?.reason ? (
          <Text variant="caption" tone="muted">
            {control.reason}
          </Text>
        ) : null}
      </View>
      <Notice message={action.error || live.problem || undefined} />
      {control?.secretWanted ? (
        <View className="gap-2">
          <TextField>
            <Label>{control.secretWanted}</Label>
            <Input
              accessibilityLabel="Secret value"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              value={secret}
              onChangeText={setSecret}
            />
          </TextField>
          <Button
            isDisabled={!secret || Boolean(action.busy)}
            onPress={() => {
              void action
                .run("secret", () =>
                  supplyComputerSecret(ORGANIZATION_ID, botId, {
                    text: secret,
                  }),
                )
                // Never kept after it is sent, whether or not it was accepted.
                .finally(() => setSecret(""));
            }}
          >
            Enter it for the Bot
          </Button>
        </View>
      ) : null}
      <Pressable
        accessibilityLabel="Bot computer screen"
        accessibilityHint={driving ? "Tap to click here" : undefined}
        disabled={!driving || !frame}
        onLayout={(event) => setSize(event.nativeEvent.layout)}
        onPress={(event) => {
          if (!frame || !size.width) return;
          const scale = frame.width / size.width;
          void send("click", {
            x: Math.round(event.nativeEvent.locationX * scale),
            y: Math.round(event.nativeEvent.locationY * scale),
          });
        }}
        className={cn(
          "w-full items-center justify-center overflow-hidden rounded-lg border bg-fill",
          driving ? "border-2 border-success" : "border-border",
        )}
        // The frame's own shape, which a class can't say.
        style={{ aspectRatio: frame ? frame.width / frame.height : 16 / 10 }}
      >
        {frame ? (
          <Image
            source={{ uri: frame.uri }}
            resizeMode="contain"
            className="h-full w-full"
          />
        ) : (
          <Text tone="muted">Connecting to the screen…</Text>
        )}
      </Pressable>
      {driving ? (
        <View className="gap-3">
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <TextField>
                <Input
                  accessibilityLabel="Type into the page"
                  placeholder="Type into the focused field"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={text}
                  onChangeText={setText}
                />
              </TextField>
            </View>
            <Button
              isDisabled={!text || Boolean(action.busy)}
              onPress={() => {
                void send("type", { text }).then((sent) => {
                  if (sent) setText("");
                });
              }}
            >
              Type
            </Button>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {(["Enter", "Tab", "Backspace", "Escape"] as const).map((key) => (
              <Button
                key={key}
                size="sm"
                variant="outline"
                isDisabled={Boolean(action.busy)}
                onPress={() => {
                  void send("key", { key });
                }}
              >
                {key}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                void send("scroll", { deltaY: -500 });
              }}
            >
              Scroll up
            </Button>
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                void send("scroll", { deltaY: 500 });
              }}
            >
              Scroll down
            </Button>
          </View>
          <Button
            variant="secondary"
            isDisabled={Boolean(action.busy)}
            onPress={() => {
              void action.run("release", async () => {
                setControl(
                  await releaseComputerControl(ORGANIZATION_ID, botId, {
                    requestId,
                  }),
                );
              });
            }}
          >
            Return control to the Bot
          </Button>
        </View>
      ) : (
        <Button
          isDisabled={Boolean(action.busy) || control?.transitioning}
          onPress={() => {
            void take();
          }}
        >
          Take control
        </Button>
      )}
    </ScrollScreen>
  );
}
