const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { getPool } = require("../db/mariadb");

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name || null },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const pool = getPool();
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

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

    res.json({ token, user });
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
      user: { id: user.id, email: user.email, name: user.name }
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
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Google login failed" });
  }
});

module.exports = router;