import express from "express";
import cors from "cors";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { Buffer } from "buffer";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
app.use(cors());
app.use(express.json());

/* ======================
   CONFIG
====================== */
const TZ = process.env.TZ || "America/Los_Angeles";
const WORK_START = process.env.WORK_START || "09:00";
const WORK_END = process.env.WORK_END || "17:00";
const BUFFER_MIN = Number(process.env.BUFFER_MIN || 30);
const CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();

if (!CALENDAR_ID) throw new Error("Missing GOOGLE_CALENDAR_ID");

/* ======================
   SERVICE ACCOUNT
====================== */
if (!process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_BASE64");
}

const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

/* ======================
   GOOGLE AUTH
====================== */
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});

const calendar = google.calendar({ version: "v3", auth });

/* ======================
   HELPERS
====================== */
function getWorkWindow(date) {
  return {
    start: dayjs.tz(`${date} ${WORK_START}`, TZ),
    end: dayjs.tz(`${date} ${WORK_END}`, TZ)
  };
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

  while (
    cursor.add(duration + BUFFER_MIN, "minute").isBefore(end) ||
    cursor.add(duration + BUFFER_MIN, "minute").isSame(end)
  ) {
    const slotStart = cursor;
    const slotEnd = cursor.add(duration, "minute");

    const conflict = busy.some(b =>
      slotStart.isBefore(b.end.add(BUFFER_MIN, "minute")) &&
      slotEnd.add(BUFFER_MIN, "minute").isAfter(b.start)
    );

    if (!conflict) slots.push(slotStart.format("HH:mm"));
    cursor = cursor.add(15, "minute");
  }

  return slots;
}

/* ======================
   ROUTES
====================== */
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/slots", async (req, res) => {
  try {
    const { date, duration } = req.query;
    const busy = await getBusyTimes(date);
    const slots = calculateSlots(date, Number(duration), busy);
    res.json({ slots });
  } catch (err) {
    console.error("SLOTS ERROR FULL:", err);
    res.status(500).json({ error: "slots failed" });
  }
});

app.post("/api/book", async (req, res) => {
  try {
    const { date, time, duration, name } = req.body;

    const start = dayjs.tz(`${date} ${time}`, TZ);
    const end = start.add(Number(duration), "minute");

    const event = {
      summary: "Detail Genius – Test",
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ }
    };

    const created = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: event
    });

    res.json({ success: true, eventId: created.data.id });

  } catch (err) {
    console.error("BOOK ERROR FULL OBJECT:", err);
    res.status(500).json({
      error: "failed to create booking",
      googleError: err?.errors || err?.response?.data || err?.message || err
    });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`API listening on ${PORT}`));
