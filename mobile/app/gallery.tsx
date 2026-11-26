import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { Uniwind, useUniwind } from "uniwind";
import {
  BotOrb,
  BotTile,
  Card,
  ChoiceList,
  Composer,
  ConversationRow,
  EmptyState,
  IconButton,
  Message,
  MessageDay,
  MessageEvent,
  MessageWorking,
  Notice,
  PersonAvatar,
  Row,
  Rows,
  ScrollScreen,
  SearchBar,
  SearchField,
  Section,
  Segmented,
  SheetTitle,
  Text,
  Toggle,
} from "../src/components";
import {
  IconAlertCircle,
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

/** One part of the gallery, shown unless `only` names another. */
function Part({
  only,
  title,
  children,
}: {
  only?: string;
  title: string;
  children: ReactNode;
}) {
  if (only && !title.toLowerCase().startsWith(only.toLowerCase())) return null;
  return <Section title={title}>{children}</Section>;
}

/**
 * Every component in `src/components`, with sample content, in light and dark. Only in a
 * development build: open it at /gallery, or one part of it at /gallery?only=messages (add
 * &theme=dark for dark). Add a component here when you add it to the library.
 */
export default function Gallery() {
  const { theme } = useUniwind();
  // `/gallery?only=messages&theme=dark`: one part, in one theme, for a screenshot without scrolling.
  const params = useLocalSearchParams<{ only?: string; theme?: string }>();
  useEffect(() => {
    if (params.theme === "light" || params.theme === "dark")
      Uniwind.setTheme(params.theme);
  }, [params.theme]);

  const [segment, setSegment] = useState<"conversations" | "settings">(
    "conversations",
  );
  const [on, setOn] = useState(true);
  const [choice, setChoice] = useState<"allow" | "ask" | "hand_off">("ask");
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

        <Part only={params.only} title="Text">
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
        </Part>

        <Part only={params.only} title="Bot orbs">
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
        </Part>

        <Part only={params.only} title="Buttons">
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
        </Part>

        <Part only={params.only} title="Segmented">
          <Segmented
            label="What to show"
            options={[
              { value: "conversations", label: "Conversations" },
              { value: "settings", label: "Settings" },
            ]}
            value={segment}
            onChange={setSegment}
          />
        </Part>

        <Part only={params.only} title="Rows">
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
        </Part>

        <Part only={params.only} title="Choice list">
          <ChoiceList
            label="What a Bot does with gmail/send_email"
            options={[
              { value: "allow", label: "Take action without asking" },
              { value: "ask", label: "Ask before taking action" },
              { value: "hand_off", label: "Hand off to you" },
            ]}
            value={choice}
            onChange={setChoice}
          />
        </Part>

        <Part only={params.only} title="Cards">
          <Card>
            <Text variant="label" className="font-semibold">
              Reply to Dana about the renewal
            </Text>
            <Text>Her contract ends Friday.</Text>
            <Text variant="caption" tone="muted">
              Juno · From gmail
            </Text>
          </Card>
          <Card highlighted>
            <Text variant="label" className="font-semibold">
              The one a notification opened
            </Text>
          </Card>
        </Part>

        <Part only={params.only} title="Search field">
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations"
          />
        </Part>

        <Part only={params.only} title="Conversation rows">
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
        </Part>

        <Part only={params.only} title="Bot rows">
          <View className="-mx-4">
            <BotTile
              name="Research"
              seed="research"
              title="Finds things out, reads the sources, and writes up what it found with links."
              onPress={() => {}}
            />
            <BotTile name="Analyst" seed="analyst" onPress={() => {}} />
          </View>
        </Part>

        <Part only={params.only} title="Messages">
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
            <MessageWorking seed="research" name="Research" label="Working…" />
            <Notice
              tone="warning"
              message="Waiting for your approval to pay $24.00 on tonys.com."
              action={
                <Button size="sm" variant="outline" className="self-start">
                  Review
                </Button>
              }
            />
            <MessageEvent
              icon={IconAlertCircle}
              tone="danger"
              text="This reply stopped before it finished."
            />
          </View>
        </Part>

        <Part only={params.only} title="A Bot's Markdown">
          <Message
            from="bot"
            text={[
              "## Three picks",
              "",
              "1. **Tony's** in North Beach, *the* classic: $24 a pie",
              "2. **Golden Boy**, by the slice, cash only",
              "3. ~~Delfina~~ closed on Mondays",
              "",
              "- [x] Checked the hours",
              "- [ ] Booked a table",
              "",
              "> Get there before 6, the line is long.",
              "",
              "Run `pizza --near me` or see https://tonys.com.",
              "",
              "```",
              '{ "open": "5pm", "close": "11pm" }',
              "```",
            ].join("\n")}
          />
        </Part>

        <Part only={params.only} title="Sheet title (Android)">
          <SheetTitle title="New conversation" />
        </Part>

        <Part only={params.only} title="Message box">
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={() => setDraft("")}
            onAttach={() => {}}
            onSpeak={() => {}}
            placeholder="Message Research"
          />
        </Part>

        <Part only={params.only} title="Notices">
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
        </Part>

        <Part only={params.only} title="People">
          <View className="flex-row gap-3">
            <PersonAvatar name="Tyler Slaton" />
            <PersonAvatar name="someone@example.com" />
          </View>
        </Part>

        <Part only={params.only} title="Empty state">
          <EmptyState
            icon={IconMessages}
            title="No conversations yet"
            description="Start one with a Bot with the + button."
            action={<Button size="sm">New conversation</Button>}
          />
        </Part>
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
