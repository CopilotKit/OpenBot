import { expect, mock, test } from "bun:test";
import { createAuth } from "../src/auth";

type BeforeUser = (user: { id: string; email: string }) => Promise<unknown>;
type BeforeSession = (session: {
  id: string;
  userId: string;
  createdAt: Date;
}) => Promise<unknown>;

function databaseReturning(email: string) {
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => [{ email }],
  };
  return {
    select: () => query,
  } as never;
}

function admissionHooks(
  email: string,
  isRevoked: (email: string) => Promise<boolean> = async () => false,
) {
  const auth = createAuth(
    {
      auth: {
        baseUrl: "http://localhost:3001",
        secret: "a-long-enough-local-development-auth-secret",
        trustedOrigins: ["http://localhost:3010"],
        ownerEmail: "owner@openbot.test",
        initialAdminEmails: ["admin@openbot.test"],
        google: { clientId: "client", clientSecret: "secret" },
      },
      keyEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } as never,
    databaseReturning(email),
    isRevoked,
  );
  const hooks = auth.options.databaseHooks;
  if (!hooks?.user?.create?.before || !hooks.session?.create?.before) {
    throw new Error("owner admission hooks are not installed");
  }
  return {
    beforeUser: hooks.user.create.before as BeforeUser,
    beforeSession: hooks.session.create.before as BeforeSession,
  };
}

test("the normalized owner is admitted before first user creation", async () => {
  const revoked = mock(async () => false);
  const { beforeUser } = admissionHooks("owner@openbot.test", revoked);
  const user = { id: "owner", email: "  OWNER@OpenBot.Test " };

  await expect(beforeUser(user)).resolves.toEqual({ data: user });
  expect(revoked).toHaveBeenCalledWith("  OWNER@OpenBot.Test ");
});

test("another valid identity is denied before revocation or user creation work", async () => {
  const revoked = mock(async () => false);
  const { beforeUser } = admissionHooks("other@openbot.test", revoked);

  await expect(
    beforeUser({ id: "other", email: "other@openbot.test" }),
  ).rejects.toThrow("configured owner");
  expect(revoked).not.toHaveBeenCalled();
});

test("an existing non-owner is denied before a new session is created", async () => {
  const revoked = mock(async () => false);
  const { beforeSession } = admissionHooks("other@openbot.test", revoked);

  await expect(
    beforeSession({ id: "session", userId: "other", createdAt: new Date() }),
  ).rejects.toThrow("configured owner");
  expect(revoked).not.toHaveBeenCalled();
});
