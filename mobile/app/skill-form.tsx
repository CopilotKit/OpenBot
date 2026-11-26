import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { Description } from "heroui-native/description";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useState } from "react";
import { everyPage, ORGANIZATION_ID } from "../src/api";
import {
  getSkill,
  listSkills,
  replaceSkill,
} from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import { Notice, Screen, ScrollScreen, SheetTitle } from "../src/components";
import {
  EMPTY_SKILL_FORM,
  formOf,
  type SkillForm,
  skillRequest,
  slugFrom,
} from "../src/skill-form";
import { useLoad } from "../src/use-load";

/**
 * New skill, or Edit skill with a `slug`: its name, the command a person types after /, a line for the / menu, and
 * the instructions a Bot follows. A new skill is the person's own. The actions a skill needs are kept as they are:
 * they are chosen in OpenBot on the computer.
 */
export default function SkillFormScreen() {
  const { slug: editing } = useLocalSearchParams<{ slug?: string }>();
  const { data: session } = authClient.useSession();
  const creating = !editing;
  // Editing: the skill as it is. New: the commands already in use, so a new skill never replaces one.
  const loadSkill = useCallback(
    () => getSkill(ORGANIZATION_ID, editing ?? ""),
    [editing],
  );
  const skill = useLoad(loadSkill, Boolean(session) && !creating);
  const loadTaken = useCallback(
    async () =>
      (
        await everyPage(
          (page) => listSkills(ORGANIZATION_ID, page),
          (page) => page.skills,
        )
      ).map((each) => each.slug),
    [],
  );
  const taken = useLoad(loadTaken, Boolean(session) && creating);
  const [form, setForm] = useState<SkillForm>(EMPTY_SKILL_FORM);
  // A new skill's command follows its name until the person types one of their own.
  const [slugTyped, setSlugTyped] = useState(false);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!skill.data || filled) return;
    setFilled(true);
    setForm(formOf(skill.data));
  }, [skill.data, filled]);
  const change = (patch: Partial<SkillForm>) =>
    setForm((now) => ({ ...now, ...patch }));
  const ready =
    !busy &&
    Boolean(form.title.trim() && form.instructions.trim()) &&
    (creating ? Boolean(taken.data) : filled);

  async function save() {
    const request = skillRequest(form, {
      creating,
      taken: taken.data ?? [],
      tools: skill.data?.tools ?? [],
    });
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await replaceSkill(ORGANIZATION_ID, request.slug, request.body);
      router.back();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save the skill. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen fade={false}>
      <Stack.Screen
        options={{ title: creating ? "New skill" : "Edit skill" }}
      />
      <SheetTitle title={creating ? "New skill" : "Edit skill"} />
      <ScrollScreen className="gap-5" fade={false}>
        <Notice message={error || skill.error || taken.error} />
        <TextField isRequired>
          <Label>Name</Label>
          <Input
            placeholder="Standup"
            value={form.title}
            onChangeText={(title) =>
              change(
                creating && !slugTyped
                  ? { title, slug: slugFrom(title) }
                  : { title },
              )
            }
            autoFocus={creating}
          />
        </TextField>
        {creating ? (
          <TextField isRequired>
            <Label>Command</Label>
            <Input
              placeholder="standup"
              value={form.slug}
              onChangeText={(slug) => {
                setSlugTyped(true);
                change({ slug: slug.toLowerCase() });
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Description>
              What you type after / to use it. Lower-case letters, numbers and
              hyphens.
            </Description>
          </TextField>
        ) : (
          <TextField>
            <Label>Command</Label>
            <Description>{`/${editing}. The command stays the same.`}</Description>
          </TextField>
        )}
        <TextField>
          <Label>Summary</Label>
          <Input
            placeholder="Writes today's standup from my calendar."
            value={form.summary}
            onChangeText={(summary) => change({ summary })}
          />
          <Description>One line, shown in the / menu.</Description>
        </TextField>
        <TextField isRequired>
          <Label>Instructions</Label>
          <TextArea
            placeholder="Read my calendar for today and my open pull requests, then write three short lines for yesterday, today and blockers."
            value={form.instructions}
            onChangeText={(instructions) => change({ instructions })}
          />
          {creating ? (
            <Description>
              Only you see this skill, and it works on Bots you own.
            </Description>
          ) : null}
        </TextField>
        <Button isDisabled={!ready} onPress={() => void save()}>
          {creating ? "Save skill" : "Save changes"}
        </Button>
      </ScrollScreen>
    </Screen>
  );
}
