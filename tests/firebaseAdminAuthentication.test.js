import assert from "node:assert/strict";
import test from "node:test";
import firebaseAuth from "../src/config/firebaseAdmin.js";

test("Firebase Admin modular auth verifies the supplied ID token", async (t) => {
  const expected = { uid: "test-user", email: "test@example.com" };
  const verifyIdToken = t.mock.method(
    firebaseAuth,
    "verifyIdToken",
    async (token) => {
      assert.equal(token, "test-id-token");
      return expected;
    },
  );

  assert.equal(await firebaseAuth.verifyIdToken("test-id-token"), expected);
  assert.equal(verifyIdToken.mock.callCount(), 1);
});
