const express = require("express");
const multer = require("multer");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
const { getPool } = require("../db/mysql");
const FormData = require("form-data");

const router = express.Router();
let cloudreveCookie = null;

const CLOUDREVE_BASE = process.env.CLOUDREVE_BASE_URL;
const CLOUDREVE_PARENT =
  process.env.CLOUDREVE_PARENT_URI || "cloudreve://my/website-images";
const CLOUDREVE_EMAIL = process.env.CLOUDREVE_EMAIL;
const CLOUDREVE_PASSWORD = process.env.CLOUDREVE_PASSWORD;

if (!CLOUDREVE_BASE || !CLOUDREVE_EMAIL || !CLOUDREVE_PASSWORD) {
  throw new Error("Missing Cloudreve environment variables");
}

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

async function loginToCloudreve() {
  const payload = {
    email: CLOUDREVE_EMAIL,
    password: CLOUDREVE_PASSWORD,
  };

  // Only include these if your Cloudreve asks for captcha
  if (process.env.CLOUDREVE_CAPTCHA) {
    payload.captcha = process.env.CLOUDREVE_CAPTCHA;
  }

  if (process.env.CLOUDREVE_TICKET) {
    payload.ticket = process.env.CLOUDREVE_TICKET;
  }

  const res = await axios.post(
    `${CLOUDREVE_BASE}/session/token`,
    payload,
    {
      timeout: 30000,
      withCredentials: true,
    }
  );

  const cookies = res.headers["set-cookie"];
  cloudreveCookie = cookies?.join("; ");

  if (!cloudreveCookie) {
    throw new Error("Cloudreve login did not return session cookie");
  }
}

function getCloudreveHeaders(extra = {}) {
  return {
    Cookie: cloudreveCookie,
    ...extra,
  };
}

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

async function uploadToCloudreve(file) {
  if (!cloudreveCookie) {
    await loginToCloudreve();
  }

  const sessionRes = await axios.put(
    `${CLOUDREVE_BASE}/file/upload`,
    {
      uri: CLOUDREVE_PARENT,
      name: file.originalname,
      size: file.size,
      mime_type: file.mimetype,
    },
    {
      headers: getCloudreveHeaders(),
      timeout: 30000,
    }
  );

  if (sessionRes.data?.code !== 0) {
    throw new Error(sessionRes.data?.msg || "Upload session failed");
  }

  const sessionId =
    sessionRes.data?.data?.session_id ||
    sessionRes.data?.data?.sessionId ||
    sessionRes.data?.data?.id;

  if (!sessionId) {
    throw new Error("Cloudreve upload session ID missing");
  }

  const form = new FormData();
  form.append("file", file.buffer, file.originalname);

  const uploadRes = await axios.post(
    `${CLOUDREVE_BASE}/file/upload/${sessionId}`,
    form,
    {
      headers: getCloudreveHeaders(form.getHeaders()),
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  if (uploadRes.data?.code !== 0) {
    throw new Error(uploadRes.data?.msg || "File upload failed");
  }

  const finishRes = await axios.post(
    `${CLOUDREVE_BASE}/file/upload/${sessionId}/finish`,
    {},
    {
      headers: getCloudreveHeaders(),
      timeout: 30000,
    }
  );

  if (finishRes.data?.code !== 0) {
    throw new Error(finishRes.data?.msg || "Finish upload failed");
  }

  return finishRes.data?.data;
}

function buildImageUrl(fileUri) {
  return `${CLOUDREVE_BASE}/file/download?uri=${encodeURIComponent(fileUri)}`;
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

      const uploaded = await uploadToCloudreve(req.file);

      const fileUri = uploaded?.uri || uploaded?.path;
      if (!fileUri) {
        console.log("Cloudreve finish data:", uploaded);
        throw new Error("Cloudreve did not return a file URI/path");
      }

      const imageUrl = buildImageUrl(fileUri);

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
          imageUrl,
          fileUri,
          grams,
          buyPriceTotal,
          usdPerGram,
          estimatedValueUsd,
        ]
      );

      res.json({
        id: result.insertId,
        imagePath: imageUrl,
        imagePublicId: fileUri,
        grams,
        buyPriceTotal,
        pricePerGramUsd: usdPerGram,
        estimatedValueUsd,
        profitLoss,
      });
    } catch (err) {
      console.error("POST /api/items error:", err.response?.data || err.message || err);
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
        if (!cloudreveCookie) {
          await loginToCloudreve();
        }

        const deleteRes = await axios.delete(`${CLOUDREVE_BASE}/file`, {
          headers: getCloudreveHeaders(),
          data: {
            items: [item.image_public_id],
          },
          timeout: 30000,
        });

        if (deleteRes.data?.code !== 0) {
          console.error("Cloudreve delete failed:", deleteRes.data);
        }
      } catch (cloudErr) {
        console.error(
          "Server delete failed:",
          item.image_public_id,
          cloudErr.response?.data || cloudErr.message
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