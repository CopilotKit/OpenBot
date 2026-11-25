import { Redirect } from "expo-router";
import { Button } from "heroui-native/button";
import { useState } from "react";
import { View } from "react-native";
import { Uniwind, useUniwind } from "uniwind";
import {
  BotOrb,
  BotTile,
  Composer,
  ConversationRow,
  EmptyState,
  IconButton,
  Message,
  MessageDay,
  MessageEvent,
  Notice,
  PersonAvatar,
  Row,
  Rows,
  ScrollScreen,
  SearchBar,
  Section,
  Segmented,
  Text,
  Toggle,
} from "../src/components";
import {
  IconBell,
  IconBook,
  IconBrain,
  IconMessages,
  IconPlayerPause,
  IconPlug,
  IconSettings,
  IconTool,
} from "../src/icons";

const BOTS = [
  { id: "research", name: "Research", seed: "research" },
  { id: "analyst", name: "Analyst", seed: "analyst" },
  { id: "engineer", name: "Engineer", seed: "engineer" },
  {
    id: "general-assistant",
    name: "General Assistant",
    seed: "general-assistant",
  },
];

/**
 * Every component in `src/components`, with sample content, in light and dark. Only in a
 * development build: open it at /gallery. Add a component here when you add it to the library.
 */
export default function Gallery() {
  const { theme } = useUniwind();
  const [segment, setSegment] = useState<"conversations" | "settings">(
    "conversations",
  );
  const [on, setOn] = useState(true);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <View className="flex-1 bg-background">
      <ScrollScreen>
        <View className="flex-row items-center justify-between">
          <Text variant="title">Components</Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() =>
              Uniwind.setTheme(theme === "dark" ? "light" : "dark")
            }
          >
            {theme === "dark" ? "Light" : "Dark"}
          </Button>
        </View>

        <Section title="Text">
          <View className="gap-1">
            <Text variant="title">Your conversations</Text>
            <Text variant="heading">Settings for this Bot</Text>
            <Text variant="label">Find good pizza in San Francisco</Text>
            <Text>Your pizza analysis in San Francisco is complete.</Text>
            <Text tone="muted">Quieter text: descriptions, hints, times.</Text>
            <Text variant="caption" tone="muted">
              Today, 11:45 AM
            </Text>
          </View>
        </Section>

        <Section title="Bot orbs">
          <View className="flex-row flex-wrap items-center gap-3">
            {[
              "a",
              "b",
              "c",
              "d",
              "e",
              "f",
              "g",
              "h",
              ...BOTS.map((b) => b.seed),
            ].map((seed) => (
              <BotOrb key={seed} seed={seed} name={seed} size={36} />
            ))}
            <BotOrb seed="research" name="Working" size={36} state="working" />
            <BotOrb seed="openbot" name="OpenBot" size={72} />
          </View>
        </Section>

        <Section title="Buttons">
          <View className="gap-2">
            <Button>New Bot</Button>
            <Button variant="outline">Sign in with Google</Button>
            <Button variant="secondary">Older conversations</Button>
            <Button variant="ghost">Your account</Button>
            <Button variant="danger">Delete</Button>
            <View className="flex-row gap-2">
              <IconButton icon={IconSettings} label="Settings" />
              <IconButton
                icon={IconSettings}
                label="Settings"
                variant="outline"
              />
              <IconButton
                icon={IconSettings}
                label="Settings"
                variant="primary"
              />
              <IconButton icon={IconSettings} label="Settings" disabled />
            </View>
          </View>
        </Section>

        <Section title="Segmented">
          <Segmented
            label="What to show"
            options={[
              { value: "conversations", label: "Conversations" },
              { value: "settings", label: "Settings" },
            ]}
            value={segment}
            onChange={setSegment}
          />
        </Section>

        <Section title="Rows">
          <Rows>
            <Row
              icon={IconPlayerPause}
              title="Active"
              description="It works on its routines and follow-ups for you."
              trailing={
                <Toggle value={on} onValueChange={setOn} label="Active" />
              }
            />
            <Row
              icon={IconBell}
              title="Notifications"
              description="Everything"
              onPress={() => {}}
            />
            <Row
              icon={IconBrain}
              title="Memory"
              description="Nothing yet"
              onPress={() => {}}
            />
            <Row
              icon={IconBook}
              title="Skills"
              description="2 skills"
              onPress={() => {}}
            />
            <Row
              icon={IconPlug}
              title="Apps"
              description="1 app"
              onPress={() => {}}
            />
            <Row title="Sign out" tone="danger" onPress={() => {}} />
          </Rows>
        </Section>

        <Section title="Conversation rows">
          <View className="-mx-4">
            <ConversationRow
              name="Pizza in San Francisco"
              bots={[BOTS[0]]}
              lastMessage="Your pizza analysis in San Francisco is complete! Would you like me to find…"
              when="11:45 AM"
              unread
              onPress={() => {}}
            />
            <ConversationRow
              name="New pizzeria"
              bots={[BOTS[0], BOTS[1]]}
              lastMessage="We just found good places to put up your new pizzeria. Here are the options."
              when="Yesterday"
              working
              onPress={() => {}}
            />
            <ConversationRow
              name="Mobile app"
              bots={[BOTS[2]]}
              lastMessage="I just finished up the mobile app, what would you like me to tackle next?"
              when="Nov 23"
              onPress={() => {}}
            />
          </View>
        </Section>

        <Section title="Bot tiles">
          <View className="flex-row gap-1">
            <BotTile
              name="Research"
              seed="research"
              title="Finds things out"
              onPress={() => {}}
            />
            <BotTile name="Analyst" seed="analyst" onPress={() => {}} />
          </View>
        </Section>

        <Section title="Messages">
          <View className="gap-3">
            <MessageDay label="November 23, 10:45 AM" />
            <Message
              from="person"
              text="Could you please find the best pizza places in San Francisco?"
            />
            <Message
              from="bot"
              text="Of course, starting that right now. I'll report back once I'm done."
            />
            <Message
              from="bot"
              text="I need to use the internet to research this. Is it okay if I use my computer?"
            />
            <MessageEvent text="You approved computer use." />
            <MessageEvent icon={IconTool} text="Used 3 tools." />
            <MessageDay label="Today, 11:45 AM" />
            <Message
              from="bot"
              text="Your pizza analysis in San Francisco is complete!"
            />
            <Message from="person" text="Sending…" pending />
          </View>
        </Section>

        <Section title="Message box">
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={() => setDraft("")}
            onAttach={() => {}}
            onSpeak={() => {}}
            placeholder="Message Research"
          />
        </Section>

        <Section title="Notices">
          <View className="gap-2">
            <Notice message="Couldn't load your conversations. Try again in a moment." />
            <Notice
              tone="warning"
              message="Your sign-in needs renewing before you can do that."
            />
            <Notice
              tone="info"
              message="This conversation has ended. Start a new one from the Bot's page."
            />
          </View>
        </Section>

        <Section title="People">
          <View className="flex-row gap-3">
            <PersonAvatar name="Tyler Slaton" />
            <PersonAvatar name="someone@example.com" />
          </View>
        </Section>

        <Section title="Empty state">
          <EmptyState
            icon={IconMessages}
            title="No conversations yet"
            description="Start one with a Bot with the + button."
            action={<Button size="sm">New conversation</Button>}
          />
        </Section>
      </ScrollScreen>
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder="Search conversations"
        newLabel="New conversation"
        onNew={() => {}}
      />
    </View>
  );
}
