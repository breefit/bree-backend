export const BOTTLE_VOLUME_ML = 50;

const PACK_BOTTLE_COUNTS = {
  "7-day": 7,
  "30-day": 30,
};

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export const getConfiguredBottleWeightKg = (env = process.env) => {
  const bottleWeightKg = positiveNumber(env.DELHIVERY_BOTTLE_WEIGHT_KG);
  if (!bottleWeightKg) {
    throw new Error(
      "DELHIVERY_BOTTLE_WEIGHT_KG must be configured as the actual weight of one filled 50 ml bottle.",
    );
  }
  return bottleWeightKg;
};

const getPackageType = (item, order) => {
  if (
    order?.is_bulk_order === 1 ||
    order?.is_bulk_order === true ||
    /^bulk\s+order\b/i.test(String(item?.product_name || ""))
  ) {
    return "bulk";
  }

  const packBottleCount = positiveNumber(item?.pack_bottle_count);
  if (packBottleCount === 7) return "7-day";
  if (packBottleCount === 30) return "30-day";

  const productName = String(item?.product_name || "").toLowerCase();
  if (/7\s*[- ]?day|7\s*[- ]?pack|trial/.test(productName)) return "7-day";
  if (
    /30\s*[- ]?day|30\s*[- ]?pack|monthly/.test(productName) ||
    order?.parent_package_id ||
    order?.fulfillment_cycle
  ) {
    return "30-day";
  }

  return "product-pack";
};

export const resolveShipmentWeight = ({
  order,
  items,
  bottleWeightKg = getConfiguredBottleWeightKg(),
}) => {
  if (!order) throw new Error("Order is required to resolve shipping weight.");
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Order items are required to resolve shipping weight.");
  }

  const validatedBottleWeightKg = positiveNumber(bottleWeightKg);
  if (!validatedBottleWeightKg) {
    throw new Error("bottleWeightKg must be a positive number.");
  }

  let bottleCount = 0;
  const packageTypes = new Set();

  for (const item of items) {
    const lineQuantity = positiveNumber(item.quantity);
    if (!lineQuantity) {
      throw new Error("Order item quantity must be a positive number.");
    }

    const packageType = getPackageType(item, order);
    packageTypes.add(packageType);

    if (packageType === "bulk") {
      bottleCount += lineQuantity;
      continue;
    }

    const resolvedPackBottleCount =
      positiveNumber(item.pack_bottle_count) || PACK_BOTTLE_COUNTS[packageType];
    if (!resolvedPackBottleCount) {
      throw new Error(
        `Unable to resolve bottle count for product ${item.product_name || item.product_id || "item"}.`,
      );
    }
    bottleCount += resolvedPackBottleCount * lineQuantity;
  }

  const validatedBottleCount = positiveNumber(bottleCount);
  if (!validatedBottleCount)
    throw new Error("bottleCount must be a positive number.");

  const totalWeightKg = validatedBottleCount * validatedBottleWeightKg;
  if (!positiveNumber(totalWeightKg))
    throw new Error("totalWeightKg must be a positive number.");

  const totalWeightGrams = Number((totalWeightKg * 1000).toFixed(2));
  if (!positiveNumber(totalWeightGrams))
    throw new Error("totalWeightGrams must be a positive number.");

  const packageType = [...packageTypes].join(",");
  console.info("[SHIPPING_WEIGHT] bottleCount", validatedBottleCount);
  console.info("[SHIPPING_WEIGHT] bottleWeight", validatedBottleWeightKg, "kg");
  console.info("[SHIPPING_WEIGHT] totalWeight", totalWeightKg, "kg");
  console.info("[SHIPPING_WEIGHT] packageType", packageType);

  return {
    bottleVolumeMl: BOTTLE_VOLUME_ML,
    bottleCount: validatedBottleCount,
    bottleWeightKg: validatedBottleWeightKg,
    totalWeightKg: Number(totalWeightKg.toFixed(3)),
    totalWeightGrams,
    packageType,
  };
};
