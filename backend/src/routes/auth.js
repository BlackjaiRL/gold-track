// backend/src/routes/auth.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { getPool } = require("../db/mysql");
const { requireAuth } = require("../middleware/auth");

const {
  getSiteConfigBasic,
  getCaptcha,
  ensureCloudreveAccount,
  ensureAccessToken,
  CloudreveApiError
} = require("../services/cloudreve");

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name || null },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/**
 * Proxy site config so frontend can decide which captcha UI to show.
 * Cloudreve config includes captcha_type and, when enabled, turnstile_site_id / captcha_ReCaptchaKey, etc.
 */
router.get("/cloudreve/config", async (_req, res) => {
  try {
    const cfg = await getSiteConfigBasic();
    res.json(cfg);
  } catch (e) {
    res.status(502).json({ error: "Failed to fetch Cloudreve site config" });
  }
});

/**
 * Proxy captcha image+ticket for "normal" captcha type.
 * If Cloudreve is using Turnstile, this endpoint may not be used.
 */
router.get("/cloudreve/captcha", async (_req, res) => {
  try {
    const cap = await getCaptcha();
    res.json(cap); // {image, ticket}
  } catch (e) {
    res.status(502).json({ error: "Failed to fetch captcha" });
  }
});

/**
 * Ensure this app user has an associated Cloudreve account + valid tokens.
 * Body: { captcha?: string, ticket?: string }
 *
 * Returns:
 * - 200 { linked:true } if ok
 * - 428 { captchaRequired:true, captchaType, cfg, captcha? } if user must solve captcha
 * - 409/500 other errors
 */
router.post("/cloudreve/ensure", requireAuth, async (req, res) => {
  try {
    const { captcha, ticket } = req.body || {};
    const result = await ensureCloudreveAccount(req.user.id, { captcha, ticket });

    if (result.captchaRequired) {
      return res.status(428).json(result);
    }
    if (!result.linked && result.requiresActivation) {
      // Activation required: still a setup-required state.
      return res.status(428).json({
        linked: false,
        requiresActivation: true,
        reason: result.reason,
        cfg: result.cfg
      });
    }

    // Also ensure we have a working access token right now
    await ensureAccessToken(req.user.id, { captcha, ticket });

    res.json({ linked: true });
  } catch (e) {
    if (e instanceof CloudreveApiError && e.meta?.captchaRequired) {
      return res.status(428).json(e.meta);
    }
    res.status(500).json({ error: e.message || "Cloudreve ensure failed" });
  }
});

router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const pool = getPool();
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
      [email, passwordHash, name || null]
    );

    const user = { id: result.insertId, email, name: name || null };
    const token = signToken(user);

    // Do not force Cloudreve setup during register; UI will handle via CloudreveGate.
    res.json({ token, user, cloudreveSetupRequired: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const pool = getPool();

    const [rows] = await pool.query(
      "SELECT id, email, password_hash, name FROM users WHERE email = ?",
      [email]
    );

    if (!rows.length || !rows[0].password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
      cloudreveSetupRequired: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Missing Google credential" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { sub, email, name, picture } = payload;

    const pool = getPool();

    const [rows] = await pool.query(
      "SELECT id, email, name FROM users WHERE google_sub = ? OR email = ?",
      [sub, email]
    );

    let user;

    if (rows.length) {
      const existing = rows[0];
      await pool.query(
        "UPDATE users SET google_sub = ?, name = ?, picture_url = ? WHERE id = ?",
        [sub, name || null, picture || null, existing.id]
      );
      user = { id: existing.id, email: existing.email, name: name || existing.name };
    } else {
      const [result] = await pool.query(
        "INSERT INTO users (email, google_sub, name, picture_url) VALUES (?, ?, ?, ?)",
        [email, sub, name || null, picture || null]
      );
      user = { id: result.insertId, email, name: name || null };
    }

    const token = signToken(user);
    res.json({ token, user, cloudreveSetupRequired: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Google login failed" });
  }
});

module.exports = router;
