import express from "express";
import cors from "cors";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { google } from "googleapis";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || "America/Los_Angeles";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const WORK_START = process.env.WORK_START || "09:00";
const WORK_END = process.env.WORK_END || "17:00";
const BUFFER_MIN = Number(process.env.BUFFER_MIN || 30);

// ===== AUTH =====
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
}

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});

const calendar = google.calendar({
  version: "v3",
  auth
});

// ===== HELPERS =====
function getWorkWindow(date) {
  const start = dayjs.tz(`${date} ${WORK_START}`, TZ);
  const end = dayjs.tz(`${date} ${WORK_END}`, TZ);
  return { start, end };
}

async function getBusyTimes(date) {
  const { start, end } = getWorkWindow(date);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: CALENDAR_ID }]
    }
  });

  return (res.data.calendars[CALENDAR_ID]?.busy || []).map(b => ({
    start: dayjs(b.start),
    end: dayjs(b.end)
  }));
}

function calculateSlots(date, duration, busy) {
  const { start, end } = getWorkWindow(date);
  const slots = [];
  let cursor = start;

  while (cursor.add(duration + BUFFER_MIN, "minute").isSameOrBefore(end)) {
    const slotStart = cursor;
    const slotEnd = cursor.add(duration, "minute");

    const conflict = busy.some(b =>
      slotStart.isBefore(b.end.add(BUFFER_MIN, "minute")) &&
      slotEnd.add(BUFFER_MIN, "minute").isAfter(b.start)
    );

    if (!conflict) {
      slots.push(slotStart.format("HH:mm"));
    }

    cursor = cursor.add(15, "minute");
  }

  return slots;
}

// ===== ROUTES =====
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/api/slots", async (req, res) => {
  try {
    const { date, duration } = req.query;
    if (!date || !duration) {
      return res.status(400).json({ error: "date and duration required" });
    }

    const busy = await getBusyTimes(date);
    const slots = calculateSlots(date, Number(duration), busy);
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to fetch slots" });
  }
});

app.post("/api/book", async (req, res) => {
  try {
    const { date, time, duration, name, notes } = req.body;
    if (!date || !time || !duration || !name) {
      return res.status(400).json({ error: "missing required fields" });
    }

    const busy = await getBusyTimes(date);
    const startAt = dayjs.tz(`${date} ${time}`, TZ);
    const endAt = startAt.add(Number(duration), "minute");

    const conflict = busy.some(b =>
      startAt.isBefore(b.end.add(BUFFER_MIN, "minute")) &&
      endAt.add(BUFFER_MIN, "minute").isAfter(b.start)
    );

    if (conflict) {
      return res.status(409).json({ error: "slot no longer available" });
    }

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Detail Genius — ${name}`,
        description: notes || "",
        start: {
          dateTime: startAt.toISOString(),
          timeZone: TZ
        },
        end: {
          dateTime: endAt.toISOString(),
          timeZone: TZ
        }
      }
    });

    res.json({ ok: true, eventId: event.data.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "booking failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Detail Genius Booking API running on port ${PORT}`);
});
