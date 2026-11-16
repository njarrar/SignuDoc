import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatReminderAvailableAt,
  formatReminderInterval,
  getAutomaticReminderDueAt,
  isAutomaticReminderDue,
} from "./reminders.ts";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const SENT = 1_800_000_000;

test("an automatic reminder is due half a day before its interval is up", () => {
  assert.equal(getAutomaticReminderDueAt(SENT, 3), SENT + 3 * DAY - 12 * HOUR);

  const signer = { intervalDays: 1, lastNotifiedAt: SENT, lastNudgedAt: null };

  // Sent an hour after the job ran: the next day's run still counts.
  assert.equal(isAutomaticReminderDue(signer, SENT + 23 * HOUR), true);
  assert.equal(isAutomaticReminderDue(signer, SENT + 12 * HOUR), true);
  assert.equal(isAutomaticReminderDue(signer, SENT + 11 * HOUR), false);
});

test("the interval counts from the last invitation or reminder of any kind", () => {
  const reminded = {
    intervalDays: 2,
    lastNotifiedAt: SENT,
    lastNudgedAt: SENT + 5 * DAY,
  };

  assert.equal(isAutomaticReminderDue(reminded, SENT + 6 * DAY), false);
  assert.equal(isAutomaticReminderDue(reminded, SENT + 7 * DAY), true);
});

test("a signer who was never written to gets no reminder", () => {
  assert.equal(
    isAutomaticReminderDue(
      { intervalDays: 1, lastNotifiedAt: null, lastNudgedAt: null },
      SENT,
    ),
    false,
  );
});

test("an interval is named the way a person would say it", () => {
  assert.equal(formatReminderInterval(null), "Off");
  assert.equal(formatReminderInterval(1), "Every day");
  assert.equal(formatReminderInterval(3), "Every 3 days");
  assert.equal(formatReminderInterval(7), "Every week");
});

test("the time another reminder may be sent is given in UTC, whatever the server's zone", () => {
  const previousZone = process.env.TZ;

  try {
    for (const zone of ["UTC", "Europe/Berlin", "America/Los_Angeles"]) {
      process.env.TZ = zone;

      // 2027-01-15 08:00:00 UTC
      assert.equal(
        formatReminderAvailableAt(SENT),
        "January 15 at 8:00 AM UTC",
        zone,
      );
    }
  } finally {
    if (previousZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousZone;
    }
  }
});
