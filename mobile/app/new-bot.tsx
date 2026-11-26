import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { Description } from "heroui-native/description";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useState } from "react";
import { ORGANIZATION_ID } from "../src/api";
import { createBot } from "../src/api/generated/bots/bots";
import { Notice, Screen, ScrollScreen, SheetTitle } from "../src/components";

/**
 * New Bot: a name, what it does, and how it should work. It runs inside OpenBot and is yours
 * alone until you share it from OpenBot on your computer.
 */
export default function NewBot() {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = name.trim() && title.trim() && !busy;
  async function create() {
    setBusy(true);
    setError("");
    try {
      const { bot } = await createBot(ORGANIZATION_ID, {
        name: name.trim(),
        title: title.trim(),
        roleDescription: title.trim(),
        visibility: "private",
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      router.dismiss();
      router.push({ pathname: "/bot", params: { botId: bot.id } });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't create the Bot. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    // The title stays put above the form: in the form, the keyboard scrolling to Name would cut it off.
    <Screen>
      <SheetTitle title="New Bot" />
      <ScrollScreen className="gap-5">
        <Notice message={error} />
        <TextField isRequired>
          <Label>Name</Label>
          <Input
            placeholder="Research"
            value={name}
            onChangeText={setName}
            autoFocus
          />
        </TextField>
        <TextField isRequired>
          <Label>What it does</Label>
          <Input
            placeholder="Finds and sums up what's out there"
            value={title}
            onChangeText={setTitle}
          />
        </TextField>
        <TextField>
          <Label>Instructions</Label>
          <TextArea
            placeholder="How it should work, what to check first, what to leave alone."
            value={instructions}
            onChangeText={setInstructions}
          />
          <Description>You can change these later.</Description>
        </TextField>
        <Button isDisabled={!ready} onPress={() => void create()}>
          Create
        </Button>
      </ScrollScreen>
    </Screen>
  );
}
