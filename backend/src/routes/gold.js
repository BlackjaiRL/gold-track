const express = require("express");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const GOLD_URL =
  "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD";

function extractPrice(data) {
  const item = Array.isArray(data) ? data[0] : data;

  const candidate =
    item?.spreadProfilePrices?.[0]?.ask ??
    item?.spreadProfilePrices?.[0]?.bid ??
    item?.ask ??
    item?.bid ??
    item?.price;

  if (!candidate) {
    throw new Error("Unable to extract gold price from response");
  }

  return Number(candidate);
}

router.get("/current", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(GOLD_URL, { timeout: 10000 });
    const xauUsd = extractPrice(response.data);
    const usdPerGram = xauUsd / 31.1034768;

    res.json({
      xauUsd,
      usdPerGram,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch gold price" });
  }
});

module.exports = router;