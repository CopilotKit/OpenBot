import { arabic, arabicTemplates } from "./setup-arabic";

let language = "en";

const patterns = Object.entries(arabicTemplates).map(
  ([source, destination]) => {
    const parts = source
      .split(/\{\d+\}/)
      .map((part) => part.replace(/[.*+?^$${}()|[\]\\]/g, "\\$&"));
    return [new RegExp(`^${parts.join("(.*?)")}$`), destination] as const;
  },
);

export function setSetupLanguage(locale: string) {
  language = locale.toLowerCase().split("-")[0] === "ar" ? "ar" : "en";
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
}

export function setupText(message: string): string {
  if (language !== "ar") return message;

  const normalized = message.trim().replaceAll("’", "'").replace(/\s+/g, " ");
  if (Object.hasOwn(arabic, normalized)) return arabic[normalized];

  for (const [pattern, destination] of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return destination.replace(
        /\{(\d+)\}/g,
        (_, index) => match[Number(index) + 1],
      );
    }
  }
  return message;
}
