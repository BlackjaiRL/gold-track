// backend/src/services/cloudreve.js
const axios = require("axios");
const crypto = require("crypto");
const { getPool } = require("../db/mysql");

/**
 * Cloudreve v4 API wrapper.
 * Many endpoints return HTTP 200 with {code, msg, data} and use code!=0 for errors.
 */

class CloudreveApiError extends Error {
  constructor(message, { httpStatus, code, response, step } = {}) {
    super(message);
    this.name = "CloudreveApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.response = response;
    this.step = step;
  }
}

function cloudreveBase() {
  const base = process.env.CLOUDREVE_BASE_URL;
  if (!base) throw new Error("Missing CLOUDREVE_BASE_URL");
  return base.replace(/\/+$/, "");
}

function url(path) {
  return `${cloudreveBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseCloudreveEnvelope(resp, step) {
  const payload = resp?.data;
  if (!payload || typeof payload !== "object") {
    throw new CloudreveApiError("Invalid Cloudreve response", { step, httpStatus: resp?.status, response: payload });
  }
  if (payload.code !== 0) {
    throw new CloudreveApiError(payload.msg || "Cloudreve error", {
      step,
      httpStatus: resp?.status,
      code: payload.code,
      response: payload
    });
  }
  return payload.data;
}

async function crRequest(method, path, { token, headers, data, responseType, timeout = 30000 } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;

  try {
    const resp = await axios.request({
      method,
      url: url(path),
      headers: h,
      data,
      timeout,
      responseType
    });
    return resp;
  } catch (err) {
    const httpStatus = err.response?.status;
    const response = err.response?.data;
    throw new CloudreveApiError(err.message || "Cloudreve request failed", {
      step: `http:${method}:${path}`,
      httpStatus,
      response
    });
  }
}

/**
 * AES-256-GCM encryption for Cloudreve passwords (at rest).
 * Env: CLOUDREVE_CRED_ENC_KEY must be base64(32 bytes).
 */
function encKey() {
  const b64 = process.env.CLOUDREVE_CRED_ENC_KEY;
  if (!b64) throw new Error("Missing CLOUDREVE_CRED_ENC_KEY (base64, 32 bytes)");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("CLOUDREVE_CRED_ENC_KEY must decode to 32 bytes");
  return key;
}

function encryptString(plain) {
  const key = encKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptString(enc) {
  if (!enc) return null;
  const [v, ivB64, tagB64, dataB64] = String(enc).split(":");
  if (v !== "v1") throw new Error("Unsupported credential format");
  const key = encKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

function toMysqlDatetime(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

function isExpired(mysqlDt, skewSeconds = 30) {
  if (!mysqlDt) return true;
  const t = new Date(mysqlDt).getTime();
  return t <= Date.now() + skewSeconds * 1000;
}

/** --- Cloudreve API methods --- */

async function getSiteConfigBasic(token) {
  const resp = await crRequest("GET", "/site/config/basic", { token });
  return parseCloudreveEnvelope(resp, "site_config_basic");
}

async function getCaptcha() {
  const resp = await crRequest("GET", "/site/captcha");
  // data: {image, ticket}
  return parseCloudreveEnvelope(resp, "captcha");
}

async function signUp({ email, password, language = "en-US", captcha, ticket }) {
  const body = { email, password, language };
  if (captcha != null) body.captcha = captcha;
  if (ticket != null) body.ticket = ticket;

  const resp = await crRequest("POST", "/user", {
    headers: { "Content-Type": "application/json" },
    data: body
  });
  return parseCloudreveEnvelope(resp, "signup");
}

async function passwordSignIn({ email, password, captcha, ticket }) {
  const body = { email, password };
  if (captcha != null) body.captcha = captcha;
  if (ticket != null) body.ticket = ticket;

  const resp = await crRequest("POST", "/session/token", {
    headers: { "Content-Type": "application/json" },
    data: body
  });
  // data: {user, token}
  return parseCloudreveEnvelope(resp, "password_sign_in");
}

async function finish2FA({ opt, session_id }) {
  const resp = await crRequest("POST", "/session/token/2fa", {
    headers: { "Content-Type": "application/json" },
    data: { opt, session_id }
  });
  return parseCloudreveEnvelope(resp, "2fa_finish");
}

async function refreshToken(refresh_token) {
  const resp = await crRequest("POST", "/session/token/refresh", {
    headers: { "Content-Type": "application/json" },
    data: { refresh_token }
  });
  // data: {access_token, refresh_token, access_expires, refresh_expires}
  return parseCloudreveEnvelope(resp, "refresh_token");
}

async function createFile({ token, type, uri, err_on_conflict = false }) {
  const resp = await crRequest("POST", "/file/create", {
    token,
    headers: { "Content-Type": "application/json" },
    data: { type, uri, err_on_conflict }
  });
  return parseCloudreveEnvelope(resp, "file_create");
}

async function createUploadSession({ token, uri, size, policy_id, last_modified, mime_type, encryption_supported }) {
  const body = { uri, size, policy_id, last_modified, mime_type };
  if (encryption_supported) body.encryption_supported = encryption_supported;

  const resp = await crRequest("PUT", "/file/upload", {
    token,
    headers: { "Content-Type": "application/json" },
    data: body
  });
  return parseCloudreveEnvelope(resp, "upload_session");
}

async function uploadChunk({ token, sessionId, index, buffer }) {
  const resp = await crRequest("POST", `/file/upload/${encodeURIComponent(sessionId)}/${index}`, {
    token,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": buffer.length
    },
    data: buffer,
    timeout: 120000
  });
  parseCloudreveEnvelope(resp, "upload_chunk");
  return true;
}

async function createDirectLinks({ token, uris }) {
  const resp = await crRequest("PUT", "/file/source", {
    token,
    headers: { "Content-Type": "application/json" },
    data: { uris }
  });
  return parseCloudreveEnvelope(resp, "direct_links");
}

async function createDownloadUrls({ token, uris, archive = false }) {
  const resp = await crRequest("POST", "/file/url", {
    token,
    headers: { "Content-Type": "application/json" },
    data: { uris, archive }
  });
  return parseCloudreveEnvelope(resp, "download_urls");
}

async function deleteFiles({ token, uris, unlink = false, skip_soft_delete = true }) {
  const resp = await crRequest("DELETE", "/file", {
    token,
    headers: { "Content-Type": "application/json" },
    data: { uris, unlink, skip_soft_delete }
  });
  parseCloudreveEnvelope(resp, "delete_files");
  return true;
}

/** --- Higher-level: per-app-user linking and token management --- */

function randomPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

async function loadUserForCloudreve(userId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT
       id, email,
       cloudreve_email, cloudreve_password_enc, cloudreve_user_id,
       cloudreve_access_token, cloudreve_access_expires_at,
       cloudreve_refresh_token, cloudreve_refresh_expires_at,
       cloudreve_connected_at
     FROM users WHERE id = ?`,
    [userId]
  );
  if (!rows.length) throw new Error("User not found");
  return rows[0];
}

async function saveCloudreveAuth(userId, { cloudreve_email, cloudreve_password_enc, cloudreve_user_id, token }) {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET
       cloudreve_email = ?,
       cloudreve_password_enc = ?,
       cloudreve_user_id = ?,
       cloudreve_access_token = ?,
       cloudreve_access_expires_at = ?,
       cloudreve_refresh_token = ?,
       cloudreve_refresh_expires_at = ?,
       cloudreve_connected_at = IF(cloudreve_connected_at IS NULL, NOW(), cloudreve_connected_at)
     WHERE id = ?`,
    [
      cloudreve_email || null,
      cloudreve_password_enc || null,
      cloudreve_user_id || null,
      token?.access_token || null,
      toMysqlDatetime(token?.access_expires) || null,
      token?.refresh_token || null,
      toMysqlDatetime(token?.refresh_expires) || null,
      userId
    ]
  );
}

/**
 * Ensure Cloudreve account exists for this app user.
 * If captcha is required and missing, return an object with captchaRequired=true.
 */
async function ensureCloudreveAccount(userId, { captcha, ticket } = {}) {
  const u = await loadUserForCloudreve(userId);
  const cfg = await getSiteConfigBasic(); // may include captcha_type and keys

  // register/login flags may be omitted if false (omitempty); default false
  const registerEnabled = !!cfg.register_enabled;
  const regCaptcha = !!cfg.reg_captcha;
  const loginCaptcha = !!cfg.login_captcha;
  const captchaType = cfg.captcha_type || null;

  // If already linked, just return
  if (u.cloudreve_email && u.cloudreve_password_enc) {
    return { linked: true, captchaType, cfg };
  }

  if (!registerEnabled) {
    return { linked: false, reason: "Cloudreve registration disabled", captchaType, cfg };
  }

  // If registration captcha is enabled and captcha missing, signal to UI
  if (regCaptcha && !captcha) {
    // For "normal" we can provide image+ticket; for other types, UI uses sitekey.
    if (captchaType === "normal") {
      const cap = await getCaptcha();
      return {
        linked: false,
        captchaRequired: true,
        captchaType,
        cfg,
        captcha: { image: cap.image, ticket: cap.ticket }
      };
    }
    return { linked: false, captchaRequired: true, captchaType, cfg };
  }

  // Decision: use the app user's email as Cloudreve email to avoid collisions and activation delivery ambiguity.
  const cloudEmail = u.email;
  const cloudPass = randomPassword();

  // Attempt sign up
  let created;
  try {
    created = await signUp({
      email: cloudEmail,
      password: cloudPass,
      language: "en-US",
      captcha,
      ticket
    });
  } catch (e) {
    // If user exists already, we cannot recover without knowing their password.
    // Keep the failure explicit to avoid silent mis-linking.
    throw e;
  }

  // If account returned inactive, caller may need to handle activation.
  if (created?.status && created.status !== "active") {
    return { linked: false, reason: `Cloudreve account status: ${created.status}`, requiresActivation: true, cfg };
  }

  // Login to obtain tokens
  const loginResp = await passwordSignIn({ email: cloudEmail, password: cloudPass, captcha, ticket });
  const tokenObj = loginResp.token;
  await saveCloudreveAuth(userId, {
    cloudreve_email: cloudEmail,
    cloudreve_password_enc: encryptString(cloudPass),
    cloudreve_user_id: loginResp.user?.id,
    token: tokenObj
  });

  return { linked: true, captchaType, cfg };
}

/**
 * Ensure valid access token for user; refresh if possible; fallback to login if needed.
 * If fallback login is necessary and captcha is required, caller should surface that to UI.
 */
async function ensureAccessToken(userId, { captcha, ticket } = {}) {
  const u = await loadUserForCloudreve(userId);

  // Access token still valid?
  if (u.cloudreve_access_token && !isExpired(u.cloudreve_access_expires_at, 60)) {
    return u.cloudreve_access_token;
  }

  // Refresh token valid?
  if (u.cloudreve_refresh_token && !isExpired(u.cloudreve_refresh_expires_at, 60)) {
    const tok = await refreshToken(u.cloudreve_refresh_token);
    // refresh endpoint returns token pair at data root
    await saveCloudreveAuth(userId, {
      cloudreve_email: u.cloudreve_email,
      cloudreve_password_enc: u.cloudreve_password_enc,
      cloudreve_user_id: u.cloudreve_user_id,
      token: tok
    });
    return tok.access_token;
  }

  // Need login (may require captcha)
  if (!u.cloudreve_email || !u.cloudreve_password_enc) {
    throw new CloudreveApiError("Cloudreve account not linked", { step: "ensureAccessToken" });
  }

  const cfg = await getSiteConfigBasic();
  const loginCaptcha = !!cfg.login_captcha;
  const captchaType = cfg.captcha_type || null;

  if (loginCaptcha && !captcha) {
    if (captchaType === "normal") {
      const cap = await getCaptcha();
      const err = new CloudreveApiError("Captcha required", { step: "ensureAccessToken" });
      err.meta = { captchaRequired: true, captchaType, cfg, captcha: cap };
      throw err;
    }
    const err = new CloudreveApiError("Captcha required", { step: "ensureAccessToken" });
    err.meta = { captchaRequired: true, captchaType, cfg };
    throw err;
  }

  const pass = decryptString(u.cloudreve_password_enc);
  const loginResp = await passwordSignIn({
    email: u.cloudreve_email,
    password: pass,
    captcha,
    ticket
  });

  await saveCloudreveAuth(userId, {
    cloudreve_email: u.cloudreve_email,
    cloudreve_password_enc: u.cloudreve_password_enc,
    cloudreve_user_id: loginResp.user?.id,
    token: loginResp.token
  });

  return loginResp.token.access_token;
}

/**
 * Convenience: wrapper that doesn't require auth header (JWT Optional) for config.
 */
async function getSiteConfigBasicUnauthed() {
  const resp = await crRequest("GET", "/site/config/basic");
  return parseCloudreveEnvelope(resp, "site_config_basic");
}

module.exports = {
  CloudreveApiError,
  getSiteConfigBasic: getSiteConfigBasicUnauthed,
  getCaptcha,
  signUp,
  passwordSignIn,
  finish2FA,
  refreshToken,
  createFile,
  createUploadSession,
  uploadChunk,
  createDirectLinks,
  createDownloadUrls,
  deleteFiles,
  ensureCloudreveAccount,
  ensureAccessToken
};
