/**
 * Who a task belongs to and how it began, held in memory once read.
 *
 * Both are fixed when a task is made and never change, and the approval gate asks them on every
 * gated tool call in a task's conversation ("was this started from a check-in?"). So each is read
 * from Intelligence once per instance and kept, rather than read on every call.
 */
import { conversations } from "../conversations/directory";

type Origin = { userId: string; origin: string };

const MAX_HELD = 20_000;
const held = new Map<string, Origin>();

export async function taskOrigin(taskId: string): Promise<Origin | null> {
  const known = held.get(taskId);
  if (known) return known;
  const task = await conversations().client.tasks.get(taskId);
  if (!task) return null;
  const origin = { userId: task.userId, origin: task.origin };
  held.set(taskId, origin);
  if (held.size > MAX_HELD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  return origin;
}
