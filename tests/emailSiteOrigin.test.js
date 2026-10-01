/**
 * Audit note — customer email links were parsed straight out of FRONTEND_URL
 * (the comma-separated CORS allow-list): "https://www.breefit.in,http://
 * localhost:3000" produced "https://www.breefit.in,http/order/…/tracking",
 * and a list starting with localhost threw "Invalid URL" at module load.
 * getEmailSiteOrigin() validates each entry with the logo URL's rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getEmailSiteOrigin,
  DEFAULT_EMAIL_SITE_ORIGIN,
  getEmailLogoUrl,
  DEFAULT_EMAIL_LOGO_URL,
} from "../src/config/emailAssets.js";

const PROD = "https://www.breefit.in";

test("production origin is used as-is (and bare breefit.in is normalised to www)", () => {
  assert.equal(DEFAULT_EMAIL_SITE_ORIGIN, PROD);
  assert.equal(getEmailSiteOrigin("https://www.breefit.in"), PROD);
  assert.equal(getEmailSiteOrigin("https://www.breefit.in/"), PROD);
  assert.equal(getEmailSiteOrigin("https://breefit.in"), PROD);
  assert.equal(getEmailSiteOrigin("www.breefit.in"), PROD);
  assert.equal(getEmailSiteOrigin(undefined), PROD);
  assert.equal(getEmailSiteOrigin(""), PROD);
});

test("localhost / loopback origins are rejected", () => {
  for (const value of ["http://localhost:3000", "https://localhost:3000", "https://127.0.0.1", "https://0.0.0.0:8080", "https://[::1]:3000"]) {
    assert.equal(getEmailSiteOrigin(value), PROD, value);
  }
});

test("Vercel preview origins are rejected", () => {
  assert.equal(getEmailSiteOrigin("https://bree-frontend.vercel.app"), PROD);
  assert.equal(getEmailSiteOrigin("https://bree-frontend-git-feature-x.vercel.app"), PROD);
});

test("malformed, non-https and multi-entry values never produce a malformed link", () => {
  assert.equal(getEmailSiteOrigin("http://www.breefit.in"), PROD, "http is not accepted");
  assert.equal(getEmailSiteOrigin("not a url at all"), PROD);
  assert.equal(getEmailSiteOrigin("https://"), PROD);
  assert.equal(getEmailSiteOrigin("ftp://www.breefit.in"), PROD);
  // Comma-separated CORS lists: the first acceptable entry, never a mash-up.
  assert.equal(getEmailSiteOrigin("https://www.breefit.in,http://localhost:3000"), PROD);
  assert.equal(getEmailSiteOrigin("http://localhost:3000,https://www.breefit.in"), PROD);
  assert.equal(getEmailSiteOrigin("https://bree-frontend.vercel.app, http://localhost:3000"), PROD);
  // A value pasted twice ("https://breefit.in/https://www.breefit.in/").
  assert.equal(getEmailSiteOrigin("https://breefit.in/https://www.breefit.in/"), PROD);
});

test("buildOrderTrackingUrl with a comma-separated FRONTEND_URL is a valid production link", async () => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "http://localhost:3000,https://www.breefit.in,https://bree-frontend.vercel.app";
  try {
    const { buildOrderTrackingUrl } = await import("../src/services/orderEmailService.js");
    assert.equal(buildOrderTrackingUrl("order-1"), "https://www.breefit.in/order/order-1/tracking");
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
});

test("the logo URL fix is not regressed", () => {
  const previous = process.env.EMAIL_LOGO_URL;
  delete process.env.EMAIL_LOGO_URL;
  try {
    assert.equal(getEmailLogoUrl(), DEFAULT_EMAIL_LOGO_URL);
    assert.equal(DEFAULT_EMAIL_LOGO_URL, "https://www.breefit.in/images/logo.PNG");
  } finally {
    if (previous !== undefined) process.env.EMAIL_LOGO_URL = previous;
  }
});
