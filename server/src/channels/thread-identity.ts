import { createHash, randomBytes } from "node:crypto";

/**
 * Which deployment a conversation belongs to, carried by the thread's own id.
 *
 * Threads live in an Intelligence project, and one project can serve more than one deployment: a
 * development copy of production shares its key, and listing a Bot's threads returns both
 * deployments' conversations with nothing to tell them apart. The platform keeps no field a
 * deployment can write its own name into, and lists threads by user and agent only, so the single
 * identifier a deployment controls is the id it mints for the thread.
 *
 * So the id carries it: six bytes of a digest of the deployment's name lead the UUID and the rest is
 * random. That is enough to ask whether a thread is this deployment's without having seen it before,
 * which is what a workspace whose database is gone would need in order to take its own conversations
 * back and leave another deployment's alone.
 *
 * Version 8 because RFC 9562 reserves that version for a layout the vendor decides. A version 4 UUID
 * asserts that every bit outside the version and variant is random, and these are not.
 *
 * The digest is not a secret and is not meant to be one. A thread id is already visible to anyone who
 * can list the project, and this says only that two threads came from the same deployment.
 */

/** Enough of the digest to separate deployments, and short enough to leave the id mostly random. */
const FINGERPRINT_BYTES = 6;

const UUID_V8 = 0x80;
const VARIANT_RFC = 0x80;

export type ThreadIdentity = {
  /** A thread id belonging to this deployment. */
  mint: () => string;
  /**
   * Whether this deployment minted the thread id.
   *
   * False for a thread minted before a deployment had a name, which is not the same as knowing it
   * belongs to somebody else. A caller offering to take conversations back has to treat the two
   * differently: one is certainly yours, the other is only possibly.
   */
  owns: (threadId: string) => boolean;
};

function fingerprintOf(deploymentId: string): Buffer {
  return createHash("sha256")
    .update(deploymentId)
    .digest()
    .subarray(0, FINGERPRINT_BYTES);
}

function format(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 16 bytes a UUID string stands for, or null if it is not one. */
function bytesOf(threadId: string): Buffer | null {
  if (!UUID.test(threadId)) return null;
  return Buffer.from(threadId.replaceAll("-", ""), "hex");
}

export function createThreadIdentity(deploymentId: string): ThreadIdentity {
  const fingerprint = fingerprintOf(deploymentId);

  return {
    mint() {
      const bytes = randomBytes(16);
      fingerprint.copy(bytes, 0);
      // Version and variant are fixed by the format and sit outside the fingerprint's six bytes.
      bytes[6] = (bytes[6] & 0x0f) | UUID_V8;
      bytes[8] = (bytes[8] & 0x3f) | VARIANT_RFC;
      return format(bytes);
    },

    owns(threadId) {
      const bytes = bytesOf(threadId);
      if (!bytes) return false;
      if ((bytes[6] & 0xf0) !== UUID_V8) return false;
      return bytes.subarray(0, FINGERPRINT_BYTES).equals(fingerprint);
    },
  };
}
