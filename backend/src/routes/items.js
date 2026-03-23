const express = require("express");
const multer = require("multer");
const path = require("path");
const jwt = require("jsonwebtoken");
const { getPool } = require("../db/mysql");
const { requireAuth } = require("../middleware/auth");

const {
  ensureAccessToken,
  createFile,
  createUploadSession,
  uploadFileChunk,
  createDirectLinks,
  deleteFile,
  CloudreveApiError,
} = require("../services/cloudreve");

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Your Cloudreve parent folder (per-user "my" filesystem)
const PARENT_URI = process.env.CLOUDREVE_PARENT_URI || "cloudreve://my";

// Optional: policy id for create upload session
const POLICY_ID = process.env.CLOUDREVE_POLICY_ID || null;

// Helper: sanitize filename for Cloudreve URI path segment
function safeFilename(originalName) {
  const base = originalName
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const ext = path.extname(base).slice(1);
  const name = base.replace(/\.[^.]+$/, "");
  const stamp = Date.now();
  const rand = Math.random().toString(16).slice(2, 8);
  return `${name || "file"}_${stamp}_${rand}${ext ? "." + ext : ""}`;
}

// Helper: chunk a buffer
function bufferToChunks(buf, chunkSize) {
  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    chunks.push(buf.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT id, grams, buyPriceTotal, imagePath, createdAt FROM gold_items WHERE user_id = ? ORDER BY createdAt DESC",
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/items error:", err.message);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  try {
    const { grams, buyPriceTotal } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "Image required" });
    }

    const gramsNum = Number(grams);
    const buyPriceNum = Number(buyPriceTotal);

    if (!Number.isFinite(gramsNum) || gramsNum <= 0) {
      return res.status(400).json({ error: "Invalid grams" });
    }

    if (!Number.isFinite(buyPriceNum) || buyPriceNum < 0) {
      return res.status(400).json({ error: "Invalid buy price" });
    }

    const pool = getPool();

    // Load Cloudreve tokens/creds for this user
    const [uRows] = await pool.query(
      "SELECT email, cloudreve_email, cloudreve_password_enc, cloudreve_user_id, cloudreve_access_token, cloudreve_access_expires_at, cloudreve_refresh_token, cloudreve_refresh_expires_at FROM users WHERE id = ?",
      [req.user.id],
    );

    if (!uRows.length) return res.status(404).json({ error: "User not found" });

    const u = uRows[0];
    if (!u.cloudreve_password_enc) {
      return res.status(428).json({
        error: "Storage setup required",
        cloudreveSetupRequired: true,
      });
    }

    // Ensure access token
    const tokens = await ensureAccessToken({
      cloudreveEmail: u.cloudreve_email || u.email,
      cloudrevePasswordEnc: u.cloudreve_password_enc,
      accessToken: u.cloudreve_access_token,
      accessExpiresAt: u.cloudreve_access_expires_at,
      refreshToken: u.cloudreve_refresh_token,
      refreshExpiresAt: u.cloudreve_refresh_expires_at,
    });

    // Persist refreshed tokens if changed
    await pool.query(
      "UPDATE users SET cloudreve_access_token = ?, cloudreve_access_expires_at = ?, cloudreve_refresh_token = ?, cloudreve_refresh_expires_at = ?, cloudreve_user_id = COALESCE(cloudreve_user_id, ?) WHERE id = ?",
      [
        tokens.accessToken,
        tokens.accessExpiresAt,
        tokens.refreshToken,
        tokens.refreshExpiresAt,
        tokens.cloudreveUserId || null,
        req.user.id,
      ],
    );

    const accessToken = tokens.accessToken;

    // Ensure parent folder exists (create folder at PARENT_URI if desired)
    // Many Cloudreve instances will have the folder already; createFile is idempotent if err_on_conflict false.
    try {
      await createFile({
        token: accessToken,
        type: "folder",
        uri: PARENT_URI,
        err_on_conflict: false,
      });
    } catch {
      // ignore folder create errors
    }

    // Build destination uri
    const filename = safeFilename(file.originalname);
    const fileUri = `${PARENT_URI}/${encodeURIComponent(filename)}`;

    const mimeType = file.mimetype || "application/octet-stream";
    const lastModified = Date.now();

    // Create upload session
    const uploadSession = await createUploadSession({
      token: accessToken,
      uri: fileUri,
      size: file.size,
      policy_id: POLICY_ID,
      last_modified: lastModified,
      mime_type: mimeType,
    });

    const sessionId = uploadSession.session_id;
    const chunkSize = uploadSession.chunk_size || 5 * 1024 * 1024;

    const chunks = bufferToChunks(file.buffer, chunkSize);

    // Upload all chunks sequentially (you can optimize with concurrency later)
    for (let i = 0; i < chunks.length; i++) {
      await uploadFileChunk({
        token: accessToken,
        sessionId,
        index: i,
        chunkBuffer: chunks[i],
        contentType: "application/octet-stream",
      });
    }

    // Create a direct link so frontend can display image
    const links = await createDirectLinks({
      token: accessToken,
      uris: [fileUri],
    });

    const direct = Array.isArray(links) && links.length ? links[0] : null;
    const imagePath = direct?.link || null;

    if (!imagePath) {
      return res.status(500).json({ error: "Failed to generate image link" });
    }

    // Insert item
    await pool.query(
      "INSERT INTO gold_items (user_id, grams, buyPriceTotal, imagePath, file_uri) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, gramsNum, buyPriceNum, imagePath, fileUri],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(
      "POST /api/items error:",
      err.response?.data || err.message || err,
    );

    if (err instanceof CloudreveApiError && err.status === 428) {
      return res.status(428).json({
        error: "Storage setup required",
        cloudreveSetupRequired: true,
      });
    }

    res.status(500).json({ error: "Failed to create item" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const pool = getPool();

    const [rows] = await pool.query(
      "SELECT id, file_uri FROM gold_items WHERE id = ? AND user_id = ?",
      [itemId, req.user.id],
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Item not found" });
    }

    const fileUri = rows[0].file_uri;

    // Load Cloudreve tokens/creds
    const [uRows] = await pool.query(
      "SELECT email, cloudreve_email, cloudreve_password_enc, cloudreve_access_token, cloudreve_access_expires_at, cloudreve_refresh_token, cloudreve_refresh_expires_at FROM users WHERE id = ?",
      [req.user.id],
    );

    if (!uRows.length) return res.status(404).json({ error: "User not found" });

    const u = uRows[0];
    if (!u.cloudreve_password_enc) {
      // Still delete DB item even if Cloudreve isn't set up
      await pool.query("DELETE FROM gold_items WHERE id = ? AND user_id = ?", [
        itemId,
        req.user.id,
      ]);
      return res.json({ ok: true });
    }

    const tokens = await ensureAccessToken({
      cloudreveEmail: u.cloudreve_email || u.email,
      cloudrevePasswordEnc: u.cloudreve_password_enc,
      accessToken: u.cloudreve_access_token,
      accessExpiresAt: u.cloudreve_access_expires_at,
      refreshToken: u.cloudreve_refresh_token,
      refreshExpiresAt: u.cloudreve_refresh_expires_at,
    });

    await pool.query(
      "UPDATE users SET cloudreve_access_token = ?, cloudreve_access_expires_at = ?, cloudreve_refresh_token = ?, cloudreve_refresh_expires_at = ? WHERE id = ?",
      [
        tokens.accessToken,
        tokens.accessExpiresAt,
        tokens.refreshToken,
        tokens.refreshExpiresAt,
        req.user.id,
      ],
    );

    // Delete file from Cloudreve
    if (fileUri) {
      try {
        await deleteFile({
          token: tokens.accessToken,
          uris: [fileUri],
          unlink: false,
          skip_soft_delete: true,
        });
      } catch {
        // ignore Cloudreve delete errors (still delete DB record)
      }
    }

    // Delete from DB
    await pool.query("DELETE FROM gold_items WHERE id = ? AND user_id = ?", [
      itemId,
      req.user.id,
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error(
      "DELETE /api/items/:id error:",
      err.response?.data || err.message || err,
    );
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;
