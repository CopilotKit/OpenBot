/**
 * Connect your AI on the phone: pick a provider and paste its API key, as the web app's chooser does with a key
 * (app/src/components/settings/ai-connection-chooser.tsx). Used by finishing setting up (src/setup-gate.tsx) and by
 * app/setup/ai.tsx, where a conversation whose run had no AI sends the person.
 *
 * A provider's sign-in (a ChatGPT or Claude plan, a Google or xAI account) finishes in OpenBot on a computer: the
 * API has no way for it to come back to the phone. The screen says so, and reads the person's AI again every few
 * seconds and on Check again, so one connected on the computer shows here.
 */
import { Button } from "heroui-native/button";
import { Description } from "heroui-native/description";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Notice, Row, Rows, Section, Text } from "./components";
import { IconCheck } from "./icons";
import {
  connectionInput,
  type KeyForm,
  PHONE_PROVIDERS,
  type PhoneProvider,
  providerName,
} from "./setup";
import { type AiState, aiConnected, connectAi, readAiState } from "./setup-api";
import { useAction } from "./use-action";
import { useLoad } from "./use-load";
import { webLink } from "./web-link";

const EMPTY: KeyForm = { apiKey: "", baseUrl: "", model: "" };

/** What the person's Bots run on now, in a sentence, or null while they have nothing. */
function connectedLine(state: AiState): string | null {
  if (!aiConnected(state)) return null;
  if (state.personal?.uses === "organization")
    return "Bots use the AI your organization set up.";
  const provider =
    state.personal?.uses === "personal"
      ? state.personal.connection.provider
      : state.organization?.provider;
  return `${providerName(provider)} is connected.`;
}

export function ConnectAi({
  onConnectedChange,
}: {
  /** Told each time the answer comes in: whether Bots have an AI to run on now. */
  onConnectedChange?: (connected: boolean) => void;
}) {
  const { data, error, pending, refresh } = useLoad(readAiState);
  const [chosen, setChosen] = useState<PhoneProvider | null>(null);
  const [form, setForm] = useState<KeyForm>(EMPTY);
  const action = useAction();
  const muted = useCSSVariable("--color-muted") as string | undefined;
  const connected = data ? aiConnected(data) : false;
  const told = useRef(onConnectedChange);
  told.current = onConnectedChange;
  useEffect(() => {
    if (data) told.current?.(connected);
  }, [data, connected]);

  if (!data) {
    if (!error)
      return (
        <ActivityIndicator
          color={muted}
          accessibilityLabel="Loading your AI"
          className="self-start"
        />
      );
    return (
      <Notice
        message="Couldn't load your AI connections. Try again."
        action={
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            isDisabled={pending}
            onPress={() => void refresh()}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const checkAgain = (
    <Button
      size="sm"
      variant="outline"
      className="self-start"
      isDisabled={pending}
      onPress={() => void refresh()}
    >
      Check again
    </Button>
  );

  if (data.mode === "ask-admin")
    return (
      <View className="gap-4">
        <Text>
          Your organization's admin sets up the AI Bots use. Ask them to connect
          one, then check again.
        </Text>
        {connected ? null : checkAgain}
      </View>
    );

  const mode = data.mode;
  const line = connectedLine(data);
  const input = chosen ? connectionInput(chosen, form) : null;
  const busy = action.busy !== "";

  function choose(next: PhoneProvider | null) {
    action.setError("");
    setChosen(next);
    setForm({ ...EMPTY, model: next?.preset?.model ?? "" });
  }

  async function connect() {
    if (!input) return;
    const done = await action.run("connect", () => connectAi(mode, input));
    if (!done) return;
    choose(null);
    await refresh();
  }

  return (
    <View className="gap-6">
      <Text>
        {mode === "personal"
          ? "Bots need an AI model to work. Connect one with an API key. It's personal to you and never shared with your organization."
          : "Bots need an AI model to work. Connect one with an API key for everyone in your organization."}
      </Text>
      {line ? (
        <Rows>
          <Row
            icon={IconCheck}
            title={line}
            description={
              mode === "personal"
                ? "Bots use it when they work for you."
                : "Bots use it for everyone in your organization."
            }
          />
        </Rows>
      ) : null}
      {chosen ? (
        <KeyFields
          provider={chosen}
          form={form}
          busy={busy}
          onChange={(next) => {
            action.setError("");
            setForm(next);
          }}
        />
      ) : (
        <Section title={connected ? "Connect another AI" : "Choose a provider"}>
          <Rows iconless>
            {PHONE_PROVIDERS.map((provider) => (
              <Row
                key={provider.id}
                title={provider.name}
                description={provider.summary}
                onPress={() => choose(provider)}
              />
            ))}
          </Rows>
        </Section>
      )}
      <Notice message={action.error} />
      {chosen ? (
        <View className="gap-3">
          <Button isDisabled={!input || busy} onPress={() => void connect()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <Button
            variant="ghost"
            isDisabled={busy}
            onPress={() => choose(null)}
          >
            Back
          </Button>
        </View>
      ) : connected ? null : (
        <View className="gap-3">
          <Text variant="caption" tone="muted" className="text-sm leading-5">
            To use a ChatGPT or Claude plan, or sign in with Google or xAI,
            connect it in OpenBot on your computer. Then tap Check again.
          </Text>
          {checkAgain}
        </View>
      )}
    </View>
  );
}

/** The provider's fields: an address and a model for an endpoint of the person's own, a model for any endpoint, and the key. */
function KeyFields({
  provider,
  form,
  busy,
  onChange,
}: {
  provider: PhoneProvider;
  form: KeyForm;
  busy: boolean;
  onChange: (form: KeyForm) => void;
}) {
  const keyPage = provider.preset ? webLink(provider.preset.keyUrl) : null;
  return (
    <View className="gap-5">
      <Text variant="heading">{provider.name}</Text>
      {provider.login === "endpoint" && !provider.preset ? (
        <TextField isRequired>
          <Label>Address</Label>
          <Input
            placeholder="https://api.example.com/v1"
            value={form.baseUrl}
            onChangeText={(baseUrl) => onChange({ ...form, baseUrl })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
          />
          <Description>
            The address of a server that speaks OpenAI's API.
          </Description>
        </TextField>
      ) : null}
      {provider.login === "endpoint" ? (
        <TextField isRequired>
          <Label>Model name</Label>
          <Input
            placeholder={
              provider.preset?.model ?? "The name the server knows it by"
            }
            value={form.model}
            onChangeText={(model) => onChange({ ...form, model })}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
        </TextField>
      ) : null}
      <TextField isRequired={provider.login === "api-key" || !!provider.preset}>
        <Label>
          {provider.login === "endpoint" && !provider.preset
            ? "API key, if it needs one"
            : `${provider.name} API key`}
        </Label>
        <Input
          value={form.apiKey}
          onChangeText={(apiKey) => onChange({ ...form, apiKey })}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          editable={!busy}
        />
      </TextField>
      {keyPage && provider.preset ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onPress={() => void Linking.openURL(keyPage.href).catch(() => {})}
        >
          {provider.preset.keyLink}
        </Button>
      ) : null}
    </View>
  );
}
