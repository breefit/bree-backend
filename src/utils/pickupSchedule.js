// ─────────────────────────────────────────────────────────────────────────────
// Delhivery pickup scheduling — date/time helpers.
//
// Delhivery interprets pickup_date + pickup_time as India local time. These
// helpers therefore always resolve "now" in Asia/Kolkata explicitly, never
// via the server's local timezone (production runs in UTC, which made the
// old default pick "today 14:00" at 18:58 IST — already in the past).
// ─────────────────────────────────────────────────────────────────────────────

export const PICKUP_TIMEZONE = "Asia/Kolkata";
// Asia/Kolkata has had a fixed +05:30 offset with no DST since 1945.
const PICKUP_TIMEZONE_OFFSET = "+05:30";

export const PICKUP_TIME_IN_PAST = "PICKUP_TIME_IN_PAST";
export const INVALID_PICKUP_DATE_TIME = "INVALID_PICKUP_DATE_TIME";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

const istFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PICKUP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Current calendar date (YYYY-MM-DD) and time (HH:mm:ss) in Asia/Kolkata.
export const getIstNowParts = (now = new Date()) => {
  const parts = Object.fromEntries(
    istFormatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
};

const normalizeTime = (time) =>
  String(time).length === 5 ? `${time}:00` : String(time);

// Absolute instant for an IST pickup_date + pickup_time, or null if invalid
// (including impossible calendar dates such as 2026-02-30).
export const toIstPickupInstant = (pickupDate, pickupTime) => {
  if (!DATE_PATTERN.test(String(pickupDate || ""))) return null;
  if (!TIME_PATTERN.test(String(pickupTime || ""))) return null;

  const time = normalizeTime(pickupTime);
  const [hours, minutes, seconds] = time.split(":").map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const instant = new Date(`${pickupDate}T${time}${PICKUP_TIMEZONE_OFFSET}`);
  if (Number.isNaN(instant.getTime())) return null;
  // Reject dates JS silently rolls over (e.g. 2026-02-30 -> 2026-03-02).
  if (getIstNowParts(instant).date !== pickupDate) return null;
  return instant;
};

const addDaysToDateString = (dateString, days) => {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

// Default pickup_date for a given pickup_time: today (IST) if that time is
// still ahead of now, otherwise tomorrow (IST).
export const getDefaultPickupDate = (pickupTime, now = new Date()) => {
  const today = getIstNowParts(now).date;
  const pickupToday = toIstPickupInstant(today, pickupTime);
  if (pickupToday && pickupToday.getTime() > now.getTime()) return today;
  return addDaysToDateString(today, 1);
};

// Validates that a pickup slot is strictly in the future (IST). Returns null
// when valid, otherwise { code, message }. A malformed date/time that does
// not even match the expected format is left to the existing payload
// validation in delhiveryService.validatePickupPayload().
export const validatePickupSchedule = (
  { pickup_date: pickupDate, pickup_time: pickupTime } = {},
  now = new Date(),
) => {
  if (
    !DATE_PATTERN.test(String(pickupDate || "")) ||
    !TIME_PATTERN.test(String(pickupTime || ""))
  ) {
    return null;
  }

  const instant = toIstPickupInstant(pickupDate, pickupTime);
  if (!instant) {
    return {
      code: INVALID_PICKUP_DATE_TIME,
      message: `Pickup date/time ${pickupDate} ${pickupTime} is not a valid date/time.`,
    };
  }

  if (instant.getTime() <= now.getTime()) {
    const istNow = getIstNowParts(now);
    return {
      code: PICKUP_TIME_IN_PAST,
      message: `Pickup time cannot be in the past. Requested ${pickupDate} ${normalizeTime(pickupTime)} IST, current time is ${istNow.date} ${istNow.time} IST.`,
    };
  }

  return null;
};

// Detects Delhivery's permanent "pickup time in past" rejection, e.g.
// HTTP 400 { "pickup_time": "Pickup time cannot be in past" }. This is a
// validation error, never a transient one — it must not be retried as-is.
const PAST_PICKUP_PATTERN = /cannot be in (the )?past|in the past|already passed/i;

export const isPickupTimeInPastError = (error) => {
  if (!error || typeof error !== "object") return false;
  if (error.code === PICKUP_TIME_IN_PAST) return true;

  const bodies = [error, error.data, error.delhiveryError].filter(
    (body) => body && typeof body === "object",
  );
  return bodies.some((body) =>
    [body.pickup_time, body.pickup_date].some(
      (value) =>
        (typeof value === "string" && PAST_PICKUP_PATTERN.test(value)) ||
        (Array.isArray(value) &&
          value.some((v) => PAST_PICKUP_PATTERN.test(String(v)))),
    ),
  );
};
