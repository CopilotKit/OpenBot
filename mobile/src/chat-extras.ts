import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { ME, ORGANIZATION_ID } from "./api";
import {
  deleteAttachment,
  uploadConversationAttachment,
} from "./api/generated/conversations/conversations";
import {
  getModelCatalogue,
  getModelChoice,
  replaceModelChoice,
} from "./api/generated/models/models";
import type { AttachFrom, ComposerFile, ComposerModels } from "./components";
import { useLoad } from "./use-load";

/** The most files one message takes (the API's limit). */
const MOST_FILES = 8;

/** A file the person picked, as the phone hands it over. */
type Picked = { uri: string; name: string; mimeType: string; image: boolean };

/**
 * Files for the next message in a chat, as the web app's message box holds them: each one uploads
 * as soon as it is picked, and the server holds it for the person's next message there, so sending
 * needs nothing more. Removing one takes it back off the server.
 */
export function useChatFiles(channelId: string) {
  const [files, setFiles] = useState<(ComposerFile & { id?: string })[]>([]);
  const [error, setError] = useState("");

  async function pick(from: AttachFrom): Promise<Picked[]> {
    const room = MOST_FILES - files.length;
    if (room <= 0) {
      setError(`A message takes up to ${MOST_FILES} files.`);
      return [];
    }
    if (from === "photos") {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: room,
        quality: 0.85,
      });
      if (result.canceled) return [];
      return result.assets.map((asset, index) => ({
        uri: asset.uri,
        // iOS names a picked photo by a random id; it reads as "Photo" on the chip.
        name:
          asset.fileName && !/^[0-9A-F-]{36}/i.test(asset.fileName)
            ? asset.fileName
            : `Photo ${files.length + index + 1}`,
        mimeType: asset.mimeType || "image/jpeg",
        image: true,
      }));
    }
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return [];
    return result.assets.slice(0, room).map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType || "application/octet-stream",
      image: Boolean(asset.mimeType?.startsWith("image/")),
    }));
  }

  // A plain function, made again on each render: it reads the files held now, through pick.
  async function attach(from: AttachFrom) {
    setError("");
    let picked: Picked[];
    try {
      picked = await pick(from);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't open your files. Try again.",
      );
      return;
    }
    for (const file of picked) {
      const key = `${file.uri}#${Math.random()}`;
      setFiles((now) => [
        ...now,
        {
          key,
          name: file.name,
          image: file.image,
          preview: file.image ? file.uri : undefined,
          uploading: true,
        },
      ]);
      try {
        // Expo's fetch sends a file it can read as a Blob: expo-file-system's File, at the picked file's address.
        const held = await uploadConversationAttachment(
          ORGANIZATION_ID,
          channelId,
          { file: new File(file.uri) },
        );
        setFiles((now) =>
          now.map((item) =>
            item.key === key
              ? { ...item, id: held.id, uploading: false }
              : item,
          ),
        );
      } catch (failure) {
        setFiles((now) => now.filter((item) => item.key !== key));
        setError(
          failure instanceof Error
            ? failure.message
            : `Couldn't attach ${file.name}. Try again.`,
        );
      }
    }
  }

  const remove = useCallback(
    (key: string) => {
      const file = files.find((item) => item.key === key);
      setFiles((now) => now.filter((item) => item.key !== key));
      if (file?.id)
        void deleteAttachment(ORGANIZATION_ID, file.id).catch(() => {});
    },
    [files],
  );

  /** After a message went: the server sent what it held with it. */
  const sent = useCallback(() => setFiles([]), []);

  return { files, attach, remove, sent, error };
}

/**
 * The model a chat's replies run on, and the choice of another, as the web app's message box offers
 * it: shown only when the catalogue has something to pick. The choice is the person's, for this
 * chat, on every device.
 */
export function useChatModel(
  channelId: string,
  enabled: boolean,
): ComposerModels | undefined {
  const loadCatalogue = useCallback(
    () => getModelCatalogue(ORGANIZATION_ID),
    [],
  );
  const catalogue = useLoad(loadCatalogue, enabled);
  const loadChoice = useCallback(
    () => getModelChoice(ORGANIZATION_ID, ME, channelId),
    [channelId],
  );
  const choosable = Boolean(catalogue.data?.choosable);
  const choice = useLoad(loadChoice, enabled && choosable);
  const [picked, setPicked] = useState<string | null>(null);
  if (!catalogue.data || !choosable) return undefined;
  const models = catalogue.data.models;
  const current =
    picked ?? choice.data?.model ?? catalogue.data.default ?? models[0]?.id;
  const label =
    models.find((model) => model.id === current)?.label ?? "Default model";
  return {
    label,
    options: models.map((model) => ({
      id: model.id,
      label: model.label,
      chosen: model.id === current,
    })),
    onPick: (id) => {
      setPicked(id);
      void replaceModelChoice(ORGANIZATION_ID, ME, channelId, {
        // The default is no choice at all, so a later default follows it.
        model: id === catalogue.data?.default ? null : id,
        effort: null,
      })
        .then(() => choice.refresh())
        .catch(() => setPicked(null));
    },
  };
}
