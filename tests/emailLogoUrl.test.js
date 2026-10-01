import test from "node:test";
import assert from "node:assert/strict";

const PROD_LOGO = "https://www.breefit.in/images/logo.PNG";

const withEnv = async (vars, fn) => {
  const original = {};
  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("email logo defaults to the permanent production PNG", async () => {
  await withEnv({ EMAIL_LOGO_URL: undefined }, async () => {
    const { getEmailLogoUrl } = await import("../src/config/emailAssets.js");
    assert.equal(getEmailLogoUrl(), PROD_LOGO);
  });
});

test("EMAIL_LOGO_URL overrides the default when it is a permanent https URL", async () => {
  await withEnv({ EMAIL_LOGO_URL: "https://cdn.breefit.in/logo.png" }, async () => {
    const { getEmailLogoUrl } = await import("../src/config/emailAssets.js");
    assert.equal(getEmailLogoUrl(), "https://cdn.breefit.in/logo.png");
  });
});

test("EMAIL_LOGO_URL rejects relative, http, localhost, preview and /_next/ URLs", async () => {
  const { getEmailLogoUrl } = await import("../src/config/emailAssets.js");
  for (const bad of [
    "/images/logo.PNG",
    "http://www.breefit.in/images/logo.PNG",
    "https://localhost:3000/images/logo.PNG",
    "https://bree-frontend.vercel.app/images/logo.PNG",
    "https://www.breefit.in/_next/image?url=%2Fimages%2Flogo.PNG",
  ]) {
    await withEnv({ EMAIL_LOGO_URL: bad }, async () => {
      assert.equal(getEmailLogoUrl(), PROD_LOGO, bad);
    });
  }
});

test("order and bulk email logos ignore FRONTEND_URL (CORS list with preview/localhost origins)", async () => {
  await withEnv(
    {
      EMAIL_LOGO_URL: undefined,
      FRONTEND_URL: "https://bree-frontend.vercel.app,http://localhost:3000",
    },
    async () => {
      for (const file of [
        "src/services/orderEmailService.js",
        "src/services/bulkNotificationService.js",
      ]) {
        const fs = await import("fs");
        const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        assert.match(source, /const logoUrl = getEmailLogoUrl\(\);/, file);
        assert.doesNotMatch(source, /\$\{frontendUrl\}\/images\/logo/, file);
      }
      const { getEmailLogoUrl } = await import("../src/config/emailAssets.js");
      assert.equal(getEmailLogoUrl(), PROD_LOGO);
    },
  );
});
