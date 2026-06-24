import Razorpay from "razorpay";

let razorpayInstance = null;

export const getRazorpay = () => {
  if (razorpayInstance) {
    return razorpayInstance;
  }

  if (!process.env.RAZORPAY_KEY_ID) {
    throw new Error("RAZORPAY_KEY_ID is missing");
  }

  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("RAZORPAY_KEY_SECRET is missing");
  }

  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  console.log("✅ Razorpay initialized");

  // console.log("Subscriptions API Available:", !!razorpayInstance.subscriptions);

  // console.log("Pause Method:", typeof razorpayInstance.subscriptions?.pause);

  // console.log("Resume Method:", typeof razorpayInstance.subscriptions?.resume);

  // console.log("Fetch Method:", typeof razorpayInstance.subscriptions?.fetch);

  // console.log("Create Method:", typeof razorpayInstance.subscriptions?.create);

  return razorpayInstance;
};

export default getRazorpay;
