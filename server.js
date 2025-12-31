import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { Buffer } from "buffer";

/* === CREDENTIALS (this block you pasted) === */
if (!process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_BASE64");
}

const credentials = JSON.parse(
  Buffer.from(
    process.env.GOOGLE_SERVICE_ACCOUNT_BASE64,
    "base64"
  ).toString("utf8")
);

/* === GOOGLE AUTH === */
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});
