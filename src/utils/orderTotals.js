const toNonNegativeNumber = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
};

export const calculateRazorpayShippingFeePaise = ({
  isFreeShipping = false,
  shippingCharge = 0,
  shippingFee = null,
  value = null,
} = {}) => {
  if (isFreeShipping === true) {
    return 0;
  }

  const resolvedValue = value ?? shippingFee ?? shippingCharge ?? 0;
  const normalizedShippingCharge = toNonNegativeNumber(resolvedValue);

  if (normalizedShippingCharge === 0) {
    return 0;
  }

  return Math.round(normalizedShippingCharge * 100);
};

export const calculateOrderTotals = ({
  productSubtotal = 0,
  deliveryCharge = 0,
  dailyReminderPrice = 0,
  actualDiscount = 0,
}) => {
  const productSubtotalAmount = toNonNegativeNumber(productSubtotal);
  const deliveryChargeAmount = toNonNegativeNumber(deliveryCharge);
  const dailyReminderPriceAmount = toNonNegativeNumber(dailyReminderPrice);
  const actualDiscountAmount = toNonNegativeNumber(actualDiscount);

  return {
    productSubtotal: productSubtotalAmount,
    deliveryCharge: deliveryChargeAmount,
    dailyReminderPrice: dailyReminderPriceAmount,
    actualDiscount: actualDiscountAmount,
    finalTotal: Math.max(
      0,
      productSubtotalAmount +
        deliveryChargeAmount +
        dailyReminderPriceAmount -
        actualDiscountAmount,
    ),
  };
};
