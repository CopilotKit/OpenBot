/**
 * Finishing setting up, after sign-in: the terms, onboarding and Connect your AI, which a new OpenBot Cloud account
 * has to do before a Bot answers it. Without them, a person who signed up on the phone sent a message and nothing
 * came back. The root layout asks (`useSetupGate`) and draws the step over the app (`SetupGate`), as it draws Update
 * OpenBot: nothing behind it is shown failing, and once the server says there is nothing left, the app is theirs.
 *
 * What decides the step is src/setup.ts, from the server's own answers. An OpenBot older than a question is read as
 * nothing to do there, so it never holds anybody out.
 */
import { Button } from "heroui-native/button";
import { Description } from "heroui-native/description";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Linking, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";
import { ApiError } from "./api";
import type { ServiceTerms } from "./api/generated/model";
import { authClient } from "./auth";
import { Notice, Row, Rows, Text, Toggle } from "./components";
import { ConnectAi } from "./connect-ai";
import { IconFile } from "./icons";
import { unregisterPush } from "./notifications";
import {
  type Answer,
  needsOnboarding,
  nextSetupStep,
  type OnboardingStepId,
  onboardingSteps,
  resumeStep,
  type SetupFacts,
  type SetupStep,
  STEP_NUMBER,
} from "./setup";
import {
  agreeToTerms,
  finishOnboarding,
  keepOnboardingStep,
  readSetupFacts,
  saveName,
} from "./setup-api";
import { useAction } from "./use-action";
import { webLink } from "./web-link";

const AwareScrollView = withUniwind(KeyboardAwareScrollView);

/** How long the first answer may hold the app before it opens anyway: a slow network decides nothing. */
const CHECK_WAIT_MS = 8_000;

export type SetupGateState = {
  signedIn: boolean;
  /** The server's answers, once in. Null while the first check for this person is on its way. */
  facts: SetupFacts | null;
  /** The step the person has to take, or null when there is none (or no answer yet). */
  step: SetupStep | null;
  /** Whether the launch cover may lift: signed out, answered, or waited for long enough. */
  settled: boolean;
  /** Ask again. Resolves once the answer is in. */
  check: () => Promise<void>;
};

/**
 * Asked as soon as somebody is signed in, again each time the app comes back to the front (a step finished in OpenBot
 * on the computer shows up), and after each step here. A new person starts from nothing.
 */
export function useSetupGate(
  signedIn: boolean,
  person: string | undefined,
): SetupGateState {
  const [facts, setFacts] = useState<SetupFacts | null>(null);
  const [waitedOut, setWaitedOut] = useState(false);
  const round = useRef(0);
  const check = useCallback(async () => {
    if (!signedIn) return;
    const mine = ++round.current;
    const answer = await readSetupFacts();
    // Only the latest question's answer counts, and never one asked for somebody else.
    if (mine === round.current) setFacts(answer);
  }, [signedIn]);
  useEffect(() => {
    round.current += 1;
    setFacts(null);
    setWaitedOut(false);
    // A new person (or none) starts from nothing: no answer of somebody else's is kept.
    if (!signedIn || !person) return;
    void check();
    const timer = setTimeout(() => setWaitedOut(true), CHECK_WAIT_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [signedIn, person, check]);
  return {
    signedIn,
    facts,
    step: facts ? nextSetupStep(facts) : null,
    settled: !signedIn || !person || facts !== null || waitedOut,
    check,
  };
}

/** The step, over everything, while there is one. While the first answer is on its way, the page's ground. */
export function SetupGate({ gate }: { gate: SetupGateState }) {
  if (!gate.signedIn) return null;
  if (!gate.facts)
    return gate.settled ? null : (
      <View className="absolute inset-0 bg-background" />
    );
  if (!gate.step) return null;
  const email =
    gate.facts.person.kind === "answered"
      ? gate.facts.person.value.email
      : undefined;
  return (
    <View className="absolute inset-0 bg-background" accessibilityViewIsModal>
      {gate.step === "terms" ? (
        <TermsStep terms={gate.facts.terms} email={email} check={gate.check} />
      ) : (
        // Decided once on arrival, from the answers then: a new step is a new flow.
        <OnboardingFlow
          key={gate.step}
          facts={gate.facts}
          email={email}
          onDone={gate.check}
        />
      )}
    </View>
  );
}

/** One step's page: where it is in the steps, its title, what it asks, and its buttons at the end. */
function SetupFrame({
  title,
  position,
  children,
  actions,
  email,
}: {
  title: string;
  position?: string;
  children: ReactNode;
  actions: ReactNode;
  email?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <AwareScrollView
      className="flex-1"
      contentContainerClassName="flex-grow px-4"
      contentContainerStyle={{
        paddingTop: insets.top + 32,
        paddingBottom: insets.bottom + 16,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      bottomOffset={24}
    >
      <View className="w-full max-w-[480px] flex-grow gap-6 self-center">
        <View className="gap-1">
          {position ? (
            <Text variant="caption" tone="muted">
              {position}
            </Text>
          ) : null}
          <Text variant="title">{title}</Text>
        </View>
        {children}
        <View className="mt-auto gap-3 pt-2">
          {actions}
          <SignOut email={email} />
        </View>
      </View>
    </AwareScrollView>
  );
}

/** The way out that isn't a skip: who is signed in, and Sign out. */
function SignOut({ email }: { email?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text
        variant="caption"
        tone="muted"
        numberOfLines={1}
        className="flex-1 text-sm"
      >
        {email ? `Signed in as ${email}` : ""}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        isDisabled={busy}
        onPress={() => {
          setBusy(true);
          void (async () => {
            await unregisterPush().catch(() => {});
            await authClient.signOut().catch(() => {});
            setBusy(false);
          })();
        }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </Button>
    </View>
  );
}

/**
 * The terms, before anything else (OpenBot Cloud): read each in the browser, agree to them, Continue. The agreement
 * is for the version read, so terms that change while the screen is open show unticked, with the server's sentence.
 */
function TermsStep({
  terms,
  email,
  check,
}: {
  terms: Answer<ServiceTerms>;
  email?: string;
  check: () => Promise<void>;
}) {
  const [agreedTo, setAgreedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = terms.kind === "answered" ? terms.value : null;
  const current = answered?.current ?? null;
  const checked = current !== null && agreedTo === current.version;
  // Somebody who agreed to an earlier version is told what changed, not welcomed again.
  const changed = Boolean(answered?.accepted);

  async function retry() {
    setBusy(true);
    await check();
    setBusy(false);
  }

  async function agree() {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await agreeToTerms(current.version);
      await check();
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.code === "SERVICE_TERMS_CHANGED"
      ) {
        setError(failure.message);
        await check();
      } else setError("Couldn't save that you agreed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const open = (address: string) => {
    const link = webLink(address);
    if (link) void Linking.openURL(link.href).catch(() => {});
  };

  return (
    <SetupFrame
      title={changed ? "The terms have changed" : "Agree to the terms"}
      email={email}
      actions={
        current ? (
          <Button isDisabled={!checked || busy} onPress={() => void agree()}>
            Continue
          </Button>
        ) : (
          <Button isDisabled={busy} onPress={() => void retry()}>
            Try again
          </Button>
        )
      }
    >
      <Text>
        {changed
          ? "Read the new version and agree to it to keep using OpenBot."
          : "Read the terms for using OpenBot, then agree to them to continue."}
      </Text>
      {current ? (
        <>
          <Rows>
            <Row
              icon={IconFile}
              title="Terms of Service"
              description="Opens in your browser."
              onPress={() => open(current.termsOfServiceUrl)}
            />
            <Row
              icon={IconFile}
              title="Acceptable Use Policy"
              description="Opens in your browser."
              onPress={() => open(current.acceptableUseUrl)}
            />
          </Rows>
          <Rows iconless>
            <Row
              title="I agree to the Terms of Service and Acceptable Use Policy"
              trailing={
                <Toggle
                  value={checked}
                  disabled={busy}
                  label="I agree to the Terms of Service and Acceptable Use Policy"
                  onValueChange={(next) => {
                    setError("");
                    setAgreedTo(next ? current.version : null);
                  }}
                />
              }
            />
          </Rows>
        </>
      ) : null}
      <Notice
        message={
          error ||
          (terms.kind === "failed"
            ? terms.status === 503
              ? terms.message
              : "Couldn't load the terms. Try again to continue."
            : "")
        }
      />
    </SetupFrame>
  );
}

/**
 * Onboarding, as much of the web app's as the phone needs: Welcome, Connect your AI where one is needed, and the
 * person's name where it isn't known. OpenBot for Business is for somebody trying OpenBot on their own computer, so
 * it is never here. The steps are decided once, on arrival: connecting an AI or saving a name doesn't drop the step
 * from under the person. The last step's button finishes onboarding (completeOnboarding) and opens the app.
 *
 * Somebody who finished onboarding and only has their AI to connect gets that one step, and its button opens the app.
 */
function OnboardingFlow({
  facts,
  email,
  onDone,
}: {
  facts: SetupFacts;
  email?: string;
  onDone: () => Promise<void>;
}) {
  const person = facts.person.kind === "answered" ? facts.person.value : null;
  const personal = facts.ai.kind === "answered" ? facts.ai.value : null;
  const [ids] = useState<OnboardingStepId[]>(() => {
    const steps = onboardingSteps(person, personal);
    return steps.length > 0 ? steps : ["welcome"];
  });
  const [onboarded] = useState(() => !person || !needsOnboarding(person));
  const [aiConnected, setAiConnected] = useState(() =>
    personal ? personal.uses !== "none" : false,
  );
  const [current, setCurrent] = useState<OnboardingStepId>(
    () =>
      resumeStep(ids, person?.onboarding?.step, aiConnected) ??
      ids[0] ??
      "welcome",
  );
  const [name, setName] = useState(() =>
    person && person.needsName !== true ? (person.name ?? "") : "",
  );
  const action = useAction();
  const busy = action.busy !== "";

  // The person's place, kept wherever they go, so they pick up there on the phone or on the web.
  const kept = useRef(person?.onboarding?.step);
  useEffect(() => {
    if (onboarded || kept.current === STEP_NUMBER[current]) return;
    kept.current = STEP_NUMBER[current];
    // A place that isn't kept is tried again on the next move; the person is where they meant to be.
    void keepOnboardingStep(STEP_NUMBER[current]).catch(() => {
      kept.current = undefined;
    });
  }, [current, onboarded]);

  const at = ids.indexOf(current);
  const last = at === ids.length - 1;
  const position =
    ids.length > 1 ? `Step ${at + 1} of ${ids.length}` : undefined;

  async function finish() {
    if (current === "name") await saveName(name.trim());
    if (!onboarded) await finishOnboarding();
    await onDone();
  }

  const primaryDisabled =
    busy ||
    (current === "ai" && !aiConnected) ||
    (current === "name" && !name.trim());
  const primary = () => {
    if (last) void action.run("finish", finish);
    else {
      const next = ids[at + 1];
      if (next) setCurrent(next);
    }
  };
  const previous = at > 0 ? ids[at - 1] : undefined;

  const actions = (
    <>
      <Notice
        message={
          action.error
            ? current === "name"
              ? action.error
              : "Couldn't finish setting up. Try again."
            : ""
        }
      />
      <Button isDisabled={primaryDisabled} onPress={primary}>
        {busy ? "Saving…" : last ? "Get started" : "Continue"}
      </Button>
      {previous ? (
        <Button
          variant="ghost"
          isDisabled={busy}
          onPress={() => setCurrent(previous)}
        >
          Back
        </Button>
      ) : null}
    </>
  );

  if (current === "ai")
    return (
      <SetupFrame
        title="Connect your AI"
        position={position}
        email={email}
        actions={actions}
      >
        <ConnectAi onConnectedChange={setAiConnected} />
      </SetupFrame>
    );

  if (current === "name")
    return (
      <SetupFrame
        title="What should we call you?"
        position={position}
        email={email}
        actions={actions}
      >
        <TextField isRequired>
          <Label>Name</Label>
          <Input
            value={name}
            onChangeText={(next) => {
              action.setError("");
              setName(next);
            }}
            autoComplete="name"
            textContentType="name"
            maxLength={100}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (!primaryDisabled) primary();
            }}
          />
          <Description>You can change it later.</Description>
        </TextField>
      </SetupFrame>
    );

  return (
    <SetupFrame
      title="Welcome to OpenBot"
      position={position}
      email={email}
      actions={actions}
    >
      <Text>
        Give work to Bots in plain words. They tell you when it's done.
      </Text>
    </SetupFrame>
  );
}
