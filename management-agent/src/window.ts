import type { MaintenanceWindow } from "../../shared/management-contract";

const WEEK = 7 * 24 * 60;

/** Whether `now` falls inside a weekly window that starts on `weekday` at `startUtc` and lasts
 * `hours`. A window may run past midnight and past the end of the week. */
export function insideWindow(window: MaintenanceWindow, now: Date): boolean {
  const [hour = 0, minute = 0] = window.startUtc.split(":").map(Number);
  const start = window.weekday * 24 * 60 + hour * 60 + minute;
  const current =
    now.getUTCDay() * 24 * 60 + now.getUTCHours() * 60 + now.getUTCMinutes();
  return (current - start + WEEK) % WEEK < window.hours * 60;
}

/** Upgrades run only where the customer's window (if they set one) and the service's overlap. */
export function upgradeAllowedNow(
  service: MaintenanceWindow,
  customer: MaintenanceWindow | null,
  now: Date,
): boolean {
  return (
    insideWindow(service, now) &&
    (customer === null || insideWindow(customer, now))
  );
}
