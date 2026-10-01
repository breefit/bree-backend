// Public assets referenced from transactional email HTML.
//
// The email logo must be a permanent, direct, publicly reachable HTTPS file
// URL. It must NOT be derived from FRONTEND_URL: that variable is a
// comma-separated CORS allow-list (often including localhost/Vercel preview
// origins), and deriving from it produced malformed or temporary logo URLs
// (e.g. "https://bree-frontend.vercel.app,https/images/logo.PNG"), which
// email clients render as a broken image.
//
// Note the uppercase ".PNG": the frontend host is case-sensitive and
// "/images/logo.png" falls through to the SPA's index.html (200 text/html).
export const DEFAULT_EMAIL_LOGO_URL = "https://www.breefit.in/images/logo.PNG";

const isUsableEmailAssetUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname) &&
      !url.hostname.endsWith(".vercel.app") &&
      !url.pathname.startsWith("/_next/")
    );
  } catch {
    return false;
  }
};

// Customer-facing site origin for links inside emails ("TRACK YOUR ORDER",
// "VISIT WEBSITE").
//
// FIX (notification audit — email links): this used to be parsed straight
// out of FRONTEND_URL, which is the comma-separated CORS allow-list.
// "https://www.breefit.in,http://localhost:3000" produced links to
// "https://www.breefit.in,http/order/…", and a list starting with a
// localhost origin threw "Invalid URL" at module load. Each entry is now
// validated with the same rules as the logo URL (https only, never
// localhost or *.vercel.app); the first acceptable entry wins, otherwise
// the production origin.
export const DEFAULT_EMAIL_SITE_ORIGIN = "https://www.breefit.in";

const toEmailSiteOrigin = (entry) => {
  const raw = String(entry || "").trim();
  if (!raw) return null;
  // Tolerates a value pasted twice, e.g. "https://breefit.in/https://www.breefit.in/".
  const embedded = raw.match(/\/((?:https?:\/\/).+)$/);
  const candidate = embedded?.[1] || raw;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  if (!isUsableEmailAssetUrl(absolute)) return null;
  const url = new URL(absolute);
  if (url.hostname === "breefit.in") url.hostname = "www.breefit.in";
  return url.origin;
};

export const getEmailSiteOrigin = (frontendUrl = process.env.FRONTEND_URL) => {
  const entries = String(frontendUrl || "").split(",");
  for (const entry of entries) {
    const origin = toEmailSiteOrigin(entry);
    if (origin) return origin;
  }
  return DEFAULT_EMAIL_SITE_ORIGIN;
};

export const getEmailLogoUrl = () => {
  const configured = (process.env.EMAIL_LOGO_URL || "").trim();
  if (!configured) return DEFAULT_EMAIL_LOGO_URL;
  if (isUsableEmailAssetUrl(configured)) return configured;

  console.warn(
    `[EMAIL] Ignoring EMAIL_LOGO_URL="${configured}" — must be a permanent public https URL (no localhost, *.vercel.app or /_next/ paths). Using ${DEFAULT_EMAIL_LOGO_URL}`,
  );
  return DEFAULT_EMAIL_LOGO_URL;
};
