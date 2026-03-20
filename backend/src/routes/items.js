const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
const { getPool } = require("../db/mariadb");

const router = express.Router();

const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({ storage });

const GOLD_URL =
  "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD";

function extractPrice(data) {
  const item = Array.isArray(data) ? data[0] : data;
  return Number(
    item?.spreadProfilePrices?.[0]?.ask ??
      item?.spreadProfilePrices?.[0]?.bid ??
      item?.ask ??
      item?.bid ??
      item?.price,
  );
}

router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  try {
    const grams = Number(req.body.grams);
    const buyPriceTotal = Number(req.body.buyPriceTotal);

    if (!req.file) {
      return res.status(400).json({ error: "Image is required" });
    }
    if (!grams || grams <= 0) {
      return res.status(400).json({ error: "Valid grams value is required" });
    }
    if (!Number.isFinite(buyPriceTotal) || buyPriceTotal < 0) {
      return res.status(400).json({ error: "Valid buy price is required" });
    }
    const priceResponse = await axios.get(GOLD_URL, { timeout: 10000 });
    const xauUsd = extractPrice(priceResponse.data);
    const usdPerGram = xauUsd / 31.1034768;
    const estimatedValueUsd = +(grams * usdPerGram).toFixed(2);

    const pool = getPool();
    const imagePath = `/uploads/${req.file.filename}`;

    const [result] = await pool.query(
      `INSERT INTO gold_items
      (user_id, image_path, grams, buy_price_total, price_per_gram_usd, estimated_value_usd)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        imagePath,
        grams,
        buyPriceTotal,
        usdPerGram,
        estimatedValueUsd,
      ],
    );

    const profitLoss = +(estimatedValueUsd - buyPriceTotal).toFixed(2);

    res.json({
      id: result.insertId,
      imagePath,
      grams,
      buyPriceTotal,
      pricePerGramUsd: usdPerGram,
      estimatedValueUsd,
      profitLoss,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save item" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, image_path, grams, buy_price_total, price_per_gram_usd, estimated_value_usd, created_at
       FROM gold_items
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id],
    );

    const items = rows.map((item) => ({
      ...item,
      profit_loss: +(
        Number(item.estimated_value_usd) - Number(item.buy_price_total)
      ).toFixed(2),
    }));

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const itemId = Number(req.params.id);

    if (!itemId) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const pool = getPool();

    const [rows] = await pool.query(
      "SELECT id, image_path FROM gold_items WHERE id = ? AND user_id = ?",
      [itemId, req.user.id],
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Item not found" });
    }

    const item = rows[0];

    await pool.query("DELETE FROM gold_items WHERE id = ?", [itemId]);

    if (item.image_path) {
      const relativePath = item.image_path.startsWith("/")
        ? item.image_path.slice(1)
        : item.image_path;

      const absolutePath = path.join(__dirname, "..", relativePath);

      fs.unlink(absolutePath, (err) => {
        if (err) {
          console.error(
            "Failed to delete image file:",
            absolutePath,
            err.message,
          );
        } else {
          console.log("Deleted image file:", absolutePath);
        }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;
