// backend/src/routes/items.js
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
const { getPool } = require("../db/mysql");

const {
  ensureAccessToken,
  createUploadSession,
  uploadChunk,
  createDirectLinks,
  deleteFiles,
  createFile,
  CloudreveApiError
} = require("../services/cloudreve");

const router = express.Router();

const CLOUDREVE_PARENT_URI = process.env.CLOUDREVE_PARENT_URI || "cloudreve://my/website-images";
const CLOUDREVE_POLICY_ID = process.env.CLOUDREVE_POLICY_ID || null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
  }
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

function safeFilename(originalName) {
  const ext = (originalName || "").includes(".")
    ? "." + originalName.split(".").pop().toLowerCase()
    : "";
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
}

function joinUri(parent, filename) {
  const p = String(parent).replace(/\/+$/, "");
  // Keep this simple; Cloudreve URIs in docs show URL-encoded path segments.
  return `${p}/${encodeURIComponent(filename)}`;
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

      if (!req.file) return res.status(400).json({ error: "Image is required" });
      if (!Number.isFinite(grams) || grams <= 0) {
        return res.status(400).json({ error: "Valid grams value is required" });
      }
      if (!Number.isFinite(buyPriceTotal) || buyPriceTotal < 0) {
        return res.status(400).json({ error: "Valid buy price is required" });
      }

      // Ensure access token (refreshes automatically)
      let accessToken;
      try {
        accessToken = await ensureAccessToken(req.user.id);
      } catch (e) {
        // signal frontend to run Cloudreve setup
        return res.status(428).json({ error: "Storage setup required", cloudreveSetupRequired: true });
      }

      // Ensure parent folder exists (best-effort)
      // Payload for folder creation is not fully shown; we rely on "Create a new folder" example being supported.
      try {
        await createFile({ token: accessToken, type: "folder", uri: CLOUDREVE_PARENT_URI, err_on_conflict: false });
      } catch (_) {
        // ignore: folder might already exist or server may reject the inferred payload
      }

      const filename = safeFilename(req.file.originalname);
      const fileUri = joinUri(CLOUDREVE_PARENT_URI, filename);

      const session = await createUploadSession({
        token: accessToken,
        uri: fileUri,
        size: req.file.size,
        policy_id: CLOUDREVE_POLICY_ID,
        last_modified: Date.now(),
        mime_type: req.file.mimetype
      });

      const sessionId = session.session_id;
      const chunkSize = Number(session.chunk_size || req.file.size);
      if (!sessionId) throw new Error("Upload session_id missing");

      // Upload all chunks sequentially
      if (req.file.buffer.length <= chunkSize) {
        await uploadChunk({ token: accessToken, sessionId, index: 0, buffer: req.file.buffer });
      } else {
        let idx = 0;
        for (let off = 0; off < req.file.buffer.length; off += chunkSize) {
          const slice = req.file.buffer.subarray(off, off + chunkSize);
          await uploadChunk({ token: accessToken, sessionId, index: idx, buffer: slice });
          idx += 1;
        }
      }

      // For local/relay policies, no finish call required. (See Cloudreve docs.)
      // Create direct link for public image display.
      const links = await createDirectLinks({ token: accessToken, uris: [fileUri] });
      const imageUrl = links?.[0]?.link || null;

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
          imageUrl || fileUri,
          fileUri,
          grams,
          buyPriceTotal,
          usdPerGram,
          estimatedValueUsd
        ]
      );

      res.json({
        id: result.insertId,
        imagePath: imageUrl || fileUri,
        imagePublicId: fileUri,
        grams,
        buyPriceTotal,
        pricePerGramUsd: usdPerGram,
        estimatedValueUsd,
        profitLoss
      });
    } catch (err) {
      console.error("POST /api/items error:", err.response?.data || err.message || err);
      res.status(500).json({ error: err.message || "Failed to save item" });
    }
  });
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, image_path, image_public_id, grams, buy_price_total,
              price_per_gram_usd, estimated_value_usd, created_at
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
      createdAt: item.created_at
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

    if (!rows.length) return res.status(404).json({ error: "Item not found" });

    const fileUri = rows[0].image_public_id;

    if (fileUri) {
      try {
        const accessToken = await ensureAccessToken(req.user.id);
        await deleteFiles({ token: accessToken, uris: [fileUri], unlink: false, skip_soft_delete: true });
      } catch (e) {
        console.error("Cloudreve delete failed:", e.message || e);
      }
    }

    await pool.query("DELETE FROM gold_items WHERE id = ? AND user_id = ?", [
      itemId,
      req.user.id
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/items/:id error:", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;
