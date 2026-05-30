import { Router } from "express";
import { body } from "express-validator";
import {
  register,
  login,
  googleSignIn,
  getMe,
  verifyAuth,
  logout,
} from "../controllers/authController.js";
import { changePassword } from "../controllers/profileController.js";
import auth from "../middleware/auth.js";

const validate = (validations) => async (req, res, next) => {
  for (const v of validations) await v.run(req);
  const { validationResult } = await import("express-validator");
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ message: errors.array()[0].msg });
  next();
};

const router = Router();

router.post(
  "/register",
  validate([
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ]),
  register,
);

router.post(
  "/login",
  validate([
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password").notEmpty().withMessage("Password is required"),
  ]),
  login,
);

router.post(
  "/google",
  validate([
    body("token")
      .trim()
      .notEmpty()
      .withMessage("Firebase auth token is required"),
  ]),
  googleSignIn,
);

router.patch(
  "/change-password",
  auth,
  validate([
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters"),
    body("confirmPassword").custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error("Confirm password must match new password");
      }
      return true;
    }),
  ]),
  changePassword,
);

router.get("/verify", verifyAuth);
router.get("/me", auth, getMe);
router.post("/logout", logout);

export default router;
