import { Router } from "express";
import { body } from "express-validator";
import {
  sendOtp,
  verifyOtp,
  resendOtp,
  googleSignIn,
  completeProfile,
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
  "/send-otp",
  validate([
    body("mobile")
      .notEmpty()
      .withMessage("Mobile number is required")
      .bail()
      .matches(/^\d{10}$/)
      .withMessage("Mobile number must be exactly 10 digits"),
  ]),
  sendOtp,
);

router.post(
  "/verify-otp",
  validate([
    body("mobile")
      .notEmpty()
      .withMessage("Mobile number is required")
      .bail()
      .matches(/^\d{10}$/)
      .withMessage("Mobile number must be exactly 10 digits"),
    body("otp")
      .notEmpty()
      .withMessage("OTP is required")
      .bail()
      .matches(/^\d{6}$/)
      .withMessage("OTP must be exactly 6 digits"),
  ]),
  verifyOtp,
);

router.post(
  "/complete-profile",
  validate([
    body("mobile")
      .notEmpty()
      .withMessage("Mobile number is required")
      .bail()
      .matches(/^\d{10}$/)
      .withMessage("Mobile number must be exactly 10 digits"),
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required")
      .bail()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be between 2 and 100 characters"),
  ]),
  completeProfile,
);

router.post(
  "/resend-otp",
  validate([
    body("mobile")
      .notEmpty()
      .withMessage("Mobile number is required")
      .bail()
      .matches(/^\d{10}$/)
      .withMessage("Mobile number must be exactly 10 digits"),
  ]),
  resendOtp,
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
