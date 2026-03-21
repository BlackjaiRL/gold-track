const express = require("express");
const multer = require("multer");
const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");
const { requireAuth } = require("../middleware/auth");
const { getPool } = require("../db/mysql");

const router = express.Router();

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  throw new Error("Missing Cloudinary environment variables");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
    }
  },
});

const GOLD_URL =
  "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD";

function extractPrice(data) {
  const item = Array.isArray(data) ? data[0] : data;
  return Number(
    item?.spreadProfilePrices?.[0]?.ask ??
      item?.spreadProfilePrices?.[0]?.bid ??
      item?.ask ??
      item?.bid ??
      item?.price
  );
}

function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "gold-track",
        resource_type: "image",
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    uploadStream.end(buffer);
  });
}

router.post("/", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError) {
          if (uploadErr.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ error: "Image must be under 10MB" });
          }
          return res.status(400).json({ error: "Invalid image upload" });
        }
        return res.status(400).json({ error: uploadErr.message || "Upload failed" });
      }

      const grams = Number(req.body.grams);
      const buyPriceTotal = Number(req.body.buyPriceTotal);

      if (!req.file) {
        return res.status(400).json({ error: "Image is required" });
      }

      if (!Number.isFinite(grams) || grams <= 0) {
        return res.status(400).json({ error: "Valid grams value is required" });
      }

      if (!Number.isFinite(buyPriceTotal) || buyPriceTotal < 0) {
        return res.status(400).json({ error: "Valid buy price is required" });
      }

      const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
        folder: `gold-track/user-${req.user.id}`,
      });

      const priceResponse = await axios.get(GOLD_URL, { timeout: 10000 });
      const xauUsd = extractPrice(priceResponse.data);

      if (!Number.isFinite(xauUsd) || xauUsd <= 0) {
        throw new Error("Failed to retrieve valid gold price");
      }

      const usdPerGram = xauUsd / 31.1034768;
      const estimatedValueUsd = +(grams * usdPerGram).toFixed(2);
      const profitLoss = +(estimatedValueUsd - buyPriceTotal).toFixed(2);

      const pool = getPool();

      const [result] = await pool.query(
        `INSERT INTO gold_items
        (user_id, image_path, image_public_id, grams, buy_price_total, price_per_gram_usd, estimated_value_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          uploaded.secure_url,
          uploaded.public_id,
          grams,
          buyPriceTotal,
          usdPerGram,
          estimatedValueUsd,
        ]
      );

      res.json({
        id: result.insertId,
        imagePath: uploaded.secure_url,
        imagePublicId: uploaded.public_id,
        grams,
        buyPriceTotal,
        pricePerGramUsd: usdPerGram,
        estimatedValueUsd,
        profitLoss,
      });
    } catch (err) {
      console.error("POST /api/items error:", err);
      res.status(500).json({
        error: err.message || "Failed to save item",
      });
    }
  });
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT
         id,
         image_path,
         image_public_id,
         grams,
         buy_price_total,
         price_per_gram_usd,
         estimated_value_usd,
         created_at
       FROM gold_items
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    const items = rows.map((item) => ({
      id: item.id,
      imagePath: item.image_path,
      imagePublicId: item.image_public_id,
      grams: Number(item.grams),
      buyPriceTotal: Number(item.buy_price_total),
      pricePerGramUsd: Number(item.price_per_gram_usd),
      estimatedValueUsd: Number(item.estimated_value_usd),
      profitLoss: +(
        Number(item.estimated_value_usd) - Number(item.buy_price_total)
      ).toFixed(2),
      createdAt: item.created_at,
    }));

    res.json(items);
  } catch (err) {
    console.error("GET /api/items error:", err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const itemId = Number(req.params.id);

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT id, image_public_id
       FROM gold_items
       WHERE id = ? AND user_id = ?`,
      [itemId, req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Item not found" });
    }

    const item = rows[0];

    if (item.image_public_id) {
      try {
        await cloudinary.uploader.destroy(item.image_public_id, {
          resource_type: "image",
        });
      } catch (cloudErr) {
        console.error(
          "Cloudinary delete failed:",
          item.image_public_id,
          cloudErr.message
        );
      }
    }

    await pool.query("DELETE FROM gold_items WHERE id = ? AND user_id = ?", [
      itemId,
      req.user.id,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/items/:id error:", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;