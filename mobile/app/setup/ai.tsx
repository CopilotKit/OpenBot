import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { useState } from "react";
import { ScrollScreen } from "../../src/components";
import { ConnectAi } from "../../src/connect-ai";

/**
 * Connect your AI, from anywhere in the app: where a conversation whose run had no AI sends the person
 * (`connectAiRouteFor` in src/setup.ts). Done goes back to where they were once Bots have an AI to run on.
 */
export default function ConnectYourAi() {
  const [connected, setConnected] = useState(false);
  return (
    <ScrollScreen>
      <ConnectAi onConnectedChange={setConnected} />
      {connected ? (
        <Button
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/")
          }
        >
          Done
        </Button>
      ) : null}
    </ScrollScreen>
  );
}
