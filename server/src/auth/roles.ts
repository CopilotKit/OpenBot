export type OpenBotRole = "admin" | "user";

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): OpenBotRole {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  )
    ? "admin"
    : "user";
}
