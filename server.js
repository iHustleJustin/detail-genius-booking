import express from "express";
import cors from "cors";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   CONFIG
========================= */
const TZ = "America/Los_Angeles";
const WORK_START = "09:00";
const WORK_END = "17:00";
const BUFFER_MIN = 30;

/* =========================
   OAUTH CONFIG (JUSTIN)
========================= */
if (
  !process.env.GOOGLE_CLIENT_ID ||
  !process.env.GOOGLE_CLIENT_SECRET ||
  !process.env.GOOGLE_REFRESH_TOKEN
) {
  throw new Error("Missing OAuth environment variables");
}

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob"
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({
  version: "v3",
  auth: oAuth2Client
});

/* =========================
   HELPERS
========================= */
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
      items: [{ id: "primary" }]
    }
  });

  return (res.data.calendars.primary?.busy || []).map(b => ({
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

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/slots", async (req, res) => {
  try {
    const { date, duration } = req.query;
    const busy = await getBusyTimes(date);
    const slots = calculateSlots(date, Number(duration), busy);
    res.json({ slots });
  } catch (err) {
    console.error("SLOTS ERROR:", err);
    res.status(500).json({ error: "failed to fetch slots" });
  }
});

app.post("/api/book", async (req, res) => {
  try {
    const { date, time, duration, name, email, phone } = req.body;

    const start = dayjs.tz(`${date} ${time}`, TZ);
    const end = start.add(Number(duration), "minute");

    const event = {
      summary: "Detail Genius Booking",
      description: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}`,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ }
    };

    const created = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event
    });

    res.json({ success: true, eventId: created.data.id });
  } catch (err) {
    console.error("BOOK ERROR:", err);
    res.status(500).json({ error: "failed to create booking" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on ${PORT}`);
});
