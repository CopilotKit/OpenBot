import { Redirect, router } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { api, type Bot } from "../src/api";
import { authClient } from "../src/auth";
import { card, colors, heading, muted, Problem, Screen } from "../src/ui";
import { useLoad } from "../src/use-load";

/** Every Bot this person can reach, each opening its profile. */
export default function BotsScreen() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(() => api<{ agents: Bot[] }>("/api/agents"), []);
  const bots = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  return (
    <Screen refreshing={bots.pending} onRefresh={() => void bots.refresh()}>
      <Text style={heading}>Bots</Text>
      <Problem message={bots.error} />
      {bots.data?.agents.map((bot) => (
        <Pressable
          key={bot.id}
          accessibilityRole="link"
          accessibilityLabel={`Open ${bot.name}`}
          onPress={() =>
            router.push({ pathname: "/bot", params: { botId: bot.id } })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            {bot.name}
          </Text>
          {bot.title ? <Text style={muted}>{bot.title}</Text> : null}
        </Pressable>
      ))}
      {bots.data?.agents.length === 0 && (
        <Text>No Bots yet. Create one in OpenBot on your computer.</Text>
      )}
    </Screen>
  );
}
