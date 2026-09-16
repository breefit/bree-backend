import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ISSUE-026 — DEPLOYMENT.md described the wrong stack entirely
 * (PostgreSQL + Prisma + Neon, and env var names like JWT_EXPIRE/
 * EMAIL_HOST/REACT_APP_RAZORPAY_KEY that don't exist anywhere in this
 * codebase). Following it as written would misconfigure a fresh
 * deployment from scratch.
 *
 * This is a structural check on the doc file itself (there's no
 * "behavior" to execute for documentation) — proves the wrong-stack terms
 * are gone and the real stack/env var names are present, so this can't
 * silently regress back to describing a different project.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deploymentDoc = fs.readFileSync(
  path.join(__dirname, "../../DEPLOYMENT.md"),
  "utf8",
);

test("ISSUE-026: DEPLOYMENT.md no longer instructs anyone to set up the wrong database stack (Postgres/Prisma/Neon)", () => {
  // Each of these appears only in this document's own explanatory
  // callouts (the intro's "here's what was wrong before," and the
  // "Actual Stack" table's "not Postgres/Prisma/Neon" row) — never as
  // real setup instructions. No `postgresql://` connection string example
  // remains anywhere (the old doc had several); no numbered setup steps
  // reference any of these terms.
  const maxLegitimateMentions = { Prisma: 2, Neon: 2, PostgreSQL: 1 };
  for (const [term, max] of Object.entries(maxLegitimateMentions)) {
    const count = deploymentDoc.split(term).length - 1;
    assert.ok(
      count <= max,
      `"${term}" appears ${count} times — expected at most ${max} (explanatory-only)`,
    );
  }
  assert.doesNotMatch(deploymentDoc, /postgresql:\/\//);
  assert.doesNotMatch(deploymentDoc, /Step \d.*(Prisma|Neon)/i);
});

test("ISSUE-026: DEPLOYMENT.md no longer documents env var names that don't exist in the actual codebase as real variables to configure", () => {
  // `JWT_EXPIRE` itself is mentioned exactly once, deliberately, in this
  // document's own "here's what was wrong before" callout at the top —
  // not as an instruction to configure it. Every other bare occurrence
  // would be a regression back to the wrong var name.
  const bareJwtExpireCount = (deploymentDoc.match(/\bJWT_EXPIRE\b(?!S_IN)/g) || []).length;
  assert.equal(bareJwtExpireCount, 1, "JWT_EXPIRE must only appear in the explanatory callout, never as a variable to configure");

  assert.doesNotMatch(deploymentDoc, /^EMAIL_HOST=/m);
  assert.doesNotMatch(deploymentDoc, /REACT_APP_RAZORPAY_KEY=/);
});

test("ISSUE-026: DEPLOYMENT.md documents the real stack and real env var names", () => {
  assert.match(deploymentDoc, /mysql2/);
  assert.match(deploymentDoc, /DATABASE_URL/);
  assert.match(deploymentDoc, /JWT_EXPIRES_IN/);
  assert.match(deploymentDoc, /SMTP_HOST/);
  assert.match(deploymentDoc, /WAPLIFY/);
  assert.match(deploymentDoc, /Delhivery/);
  assert.match(deploymentDoc, /Razorpay/);
  assert.match(deploymentDoc, /craco/);
  assert.match(deploymentDoc, /Socket\.IO/);
});

test("ISSUE-026 regression: DEPLOYMENT.md references the real migration files and the ISSUE-007/ISSUE-016/ISSUE-025 fixes it depends on", () => {
  assert.match(deploymentDoc, /npm run migrate/);
  assert.match(deploymentDoc, /009_orders_user_fk_set_null\.sql/);
  assert.match(deploymentDoc, /SIGTERM/);
});
