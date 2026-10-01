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
      !["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) &&
      !url.hostname.endsWith(".vercel.app") &&
      !url.pathname.startsWith("/_next/")
    );
  } catch {
    return false;
  }
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
