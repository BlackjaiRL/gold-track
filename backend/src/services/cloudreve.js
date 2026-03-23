const axios = require("axios");
const crypto = require("crypto");

/**
 * Cloudreve v4 API helper + token lifecycle
 * - Uses JSON API and Bearer tokens (NOT cookies).
 * - Supports captcha types:
 *   - "normal": fetch image+ticket from /site/captcha, send captcha+ticket to /user or /session/token
 *   - "turnstile": send Turnstile token in captcha field, ticket is typically empty/omitted
 *
 * NOTE: Cloudreve deployments differ on base path. Some use /api/v4 prefix.
 * Put the correct base in CLOUDREVE_BASE_URL, e.g.
 *   https://files.example.com/api/v4
 *   https://files.example.com
 */

const BASE_URL = (process.env.CLOUDREVE_BASE_URL || "").replace(/\/+$/, "");
if (!BASE_URL) {
  console.warn("CLOUDREVE_BASE_URL is not configured");
}

// AES-256-GCM for credential encryption at rest
const ENC_KEY_B64 = process.env.CLOUDREVE_CRED_ENC_KEY || "";
const ENC_KEY = ENC_KEY_B64 ? Buffer.from(ENC_KEY_B64, "base64") : null;
if (!ENC_KEY || ENC_KEY.length !== 32) {
  console.warn(
    "CLOUDREVE_CRED_ENC_KEY must be base64-encoded 32 bytes for AES-256-GCM",
  );
}

class CloudreveApiError extends Error {
  constructor(message, { status, code, data, meta } = {}) {
    super(message);
    this.name = "CloudreveApiError";
    this.status = status || 500;
    this.code = typeof code === "number" ? code : null;
    this.data = data;
    this.meta = meta || null;
  }
}

function encryptSecret(plain) {
  if (!ENC_KEY) {
    throw new Error("Missing CLOUDREVE_CRED_ENC_KEY");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: v1:<ivB64>:<tagB64>:<cipherB64>
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

function decryptSecret(enc) {
  if (!ENC_KEY) {
    throw new Error("Missing CLOUDREVE_CRED_ENC_KEY");
  }
  if (!enc) return null;
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted secret format");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const cipherText = Buffer.from(parts[3], "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return plain.toString("utf8");
}

function isProbablyNetworkErr(err) {
  return (
    err.code === "ECONNREFUSED" ||
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ENOTFOUND"
  );
}

async function crRequest(
  method,
  path,
  { token, headers, data, responseType } = {},
) {
  try {
    const url = `${BASE_URL}${path}`;
    const resp = await axios({
      method,
      url,
      data,
      headers: {
        ...(headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      responseType: responseType || "json",
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) {
      return resp;
    }

    // Try parse error response
    const msg =
      resp.data?.msg || resp.data?.error || "Cloudreve request failed";

    throw new CloudreveApiError(msg, {
      status: resp.status,
      code: resp.data?.code,
      data: resp.data,
    });
  } catch (err) {
    if (err instanceof CloudreveApiError) throw err;
    if (isProbablyNetworkErr(err)) {
      throw new CloudreveApiError(`Cloudreve network error: ${err.message}`, {
        status: 502,
      });
    }
    throw new CloudreveApiError(err.message || "Cloudreve request error", {
      status: 500,
    });
  }
}

/**
 * Cloudreve envelope format observed:
 * { code: 0, data: ..., msg: "" }
 */
function parseCloudreveEnvelope(resp) {
  const body = resp?.data;
  if (!body || typeof body !== "object") {
    throw new CloudreveApiError("Invalid Cloudreve response", { status: 502 });
  }
  if (typeof body.code === "number" && body.code !== 0) {
    throw new CloudreveApiError(body.msg || body.error || "Cloudreve error", {
      status: 400,
      code: body.code,
      data: body,
    });
  }
  return body.data;
}

// ---- Site config / captcha -------------------------------------------------

async function getSiteConfigBasic(token) {
  const resp = await crRequest("GET", "/site/config/basic", { token });
  return parseCloudreveEnvelope(resp);
}

async function getCaptcha() {
  const resp = await crRequest("GET", "/site/captcha");
  return parseCloudreveEnvelope(resp); // { image, ticket }
}

// ---- Auth ------------------------------------------------------------------

/**
 * POST /user
 * Body:
 * - email, password, language
 * - captcha, ticket (optional/required depending on config)
 */
async function signUp({ email, password, language, captcha, ticket }) {
  const resp = await crRequest("POST", "/user", {
    data: { email, password, language, captcha, ticket },
  });
  return parseCloudreveEnvelope(resp); // user object
}

/**
 * POST /session/token
 * Body:
 * - email, password
 * - captcha, ticket (optional/required depending on config)
 */
async function passwordSignIn({ email, password, captcha, ticket }) {
  const resp = await crRequest("POST", "/session/token", {
    data: { email, password, captcha, ticket },
  });
  return parseCloudreveEnvelope(resp); // { user, token }
}

/**
 * POST /session/token/refresh
 */
async function refreshToken(refresh_token) {
  const resp = await crRequest("POST", "/session/token/refresh", {
    data: { refresh_token },
  });
  return parseCloudreveEnvelope(resp); // { access_token, refresh_token, access_expires, refresh_expires }
}

/**
 * Ensures a Cloudreve account exists for this app user.
 * - If user has no cloudreve_password_enc, create an account (signUp) with a generated password.
 * - If captchas required (reg_captcha/login_captcha), return meta for frontend.
 *
 * Returns:
 * { created: boolean, cloudreveEmail, cloudrevePasswordEnc, cloudreveUserId, captchaRequired?, captchaType?, cfg?, captcha? }
 */
async function ensureCloudreveAccount({
  appEmail,
  appName,
  existingCloudrevePasswordEnc,
  captcha,
  ticket,
}) {
  if (existingCloudrevePasswordEnc) {
    return {
      created: false,
      cloudreveEmail: appEmail,
      cloudrevePasswordEnc: existingCloudrevePasswordEnc,
    };
  }

  const cfg = await getSiteConfigBasic();
  const captchaType = cfg.captcha_type || "normal";
  const regCaptcha = !!cfg.reg_captcha;
  const loginCaptcha = !!cfg.login_captcha;

  // If Cloudreve requires captcha for registration and we don't have it, return requirement
  if (regCaptcha && !captcha) {
    if (captchaType === "normal") {
      const cap = await getCaptcha();
      return {
        created: false,
        captchaRequired: true,
        captchaType,
        cfg,
        captcha: { image: cap.image, ticket: cap.ticket },
      };
    }

    // turnstile/recaptcha/etc: frontend must render provider and submit captcha token
    return {
      created: false,
      captchaRequired: true,
      captchaType,
      cfg,
    };
  }

  const generatedPassword = crypto.randomBytes(24).toString("base64url");
  const language = "en-US";
  const user = await signUp({
    email: appEmail,
    password: generatedPassword,
    language,
    captcha,
    ticket,
  });

  // If Cloudreve requires email activation, status may be inactive
  if (user?.status && user.status !== "active") {
    return {
      created: true,
      requiresActivation: true,
      cloudreveEmail: appEmail,
      cloudrevePasswordEnc: encryptSecret(generatedPassword),
      cloudreveUserId: user.id || null,
      status: user.status,
    };
  }

  return {
    created: true,
    cloudreveEmail: appEmail,
    cloudrevePasswordEnc: encryptSecret(generatedPassword),
    cloudreveUserId: user.id || null,
  };
}

/**
 * Ensures we have a valid access token.
 * If access token expired:
 * - try refresh using refresh token
 * - if refresh fails, attempt password login (may require captcha)
 *
 * Returns:
 * { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, cloudreveUserId? }
 */
async function ensureAccessToken({
  cloudreveEmail,
  cloudrevePasswordEnc,
  accessToken,
  accessExpiresAt,
  refreshToken: storedRefreshToken,
  refreshExpiresAt,
  captcha,
  ticket,
}) {
  if (!cloudreveEmail || !cloudrevePasswordEnc) {
    throw new CloudreveApiError("Missing Cloudreve credentials", {
      status: 400,
    });
  }

  const now = Date.now();

  // If access token still valid for at least 60 seconds, use it
  if (accessToken && accessExpiresAt) {
    const expMs =
      typeof accessExpiresAt === "number"
        ? accessExpiresAt
        : new Date(accessExpiresAt).getTime();
    if (expMs - now > 60 * 1000) {
      return {
        accessToken,
        accessExpiresAt: new Date(expMs).toISOString(),
        refreshToken: storedRefreshToken,
        refreshExpiresAt:
          refreshExpiresAt instanceof Date
            ? refreshExpiresAt.toISOString()
            : refreshExpiresAt,
      };
    }
  }

  // Try refresh token if present and not expired
  if (storedRefreshToken && refreshExpiresAt) {
    const rExpMs =
      typeof refreshExpiresAt === "number"
        ? refreshExpiresAt
        : new Date(refreshExpiresAt).getTime();
    if (rExpMs - now > 60 * 1000) {
      try {
        const t = await refreshToken(storedRefreshToken);
        return {
          accessToken: t.access_token,
          accessExpiresAt: t.access_expires,
          refreshToken: t.refresh_token,
          refreshExpiresAt: t.refresh_expires,
        };
      } catch (err) {
        // fallthrough to password login
      }
    }
  }

  // Password login fallback (may require captcha)
  const cfg = await getSiteConfigBasic();
  const captchaType = cfg.captcha_type || "normal";
  const loginCaptcha = !!cfg.login_captcha;

  if (loginCaptcha && !captcha) {
    if (captchaType === "normal") {
      const cap = await getCaptcha();
      throw new CloudreveApiError("Captcha required", {
        status: 428,
        meta: {
          captchaRequired: true,
          captchaType,
          cfg,
          captcha: { image: cap.image, ticket: cap.ticket },
        },
      });
    }

    throw new CloudreveApiError("Captcha required", {
      status: 428,
      meta: { captchaRequired: true, captchaType, cfg },
    });
  }

  const plainPassword = decryptSecret(cloudrevePasswordEnc);

  const login = await passwordSignIn({
    email: cloudreveEmail,
    password: plainPassword,
    captcha,
    ticket,
  });

  return {
    accessToken: login.token.access_token,
    accessExpiresAt: login.token.access_expires,
    refreshToken: login.token.refresh_token,
    refreshExpiresAt: login.token.refresh_expires,
    cloudreveUserId: login.user?.id || null,
  };
}

// ---- File APIs -------------------------------------------------------------

async function createFile({ token, type, uri, err_on_conflict }) {
  const resp = await crRequest("POST", "/file/create", {
    token,
    data: { type, uri, err_on_conflict: !!err_on_conflict },
  });
  return parseCloudreveEnvelope(resp);
}

async function createUploadSession({
  token,
  uri,
  size,
  policy_id,
  last_modified,
  mime_type,
}) {
  const resp = await crRequest("PUT", "/file/upload", {
    token,
    data: {
      uri,
      size,
      policy_id,
      last_modified,
      mime_type,
    },
  });
  return parseCloudreveEnvelope(resp);
}

async function uploadFileChunk({
  token,
  sessionId,
  index,
  chunkBuffer,
  contentType = "application/octet-stream",
}) {
  const resp = await crRequest(
    "POST",
    `/file/upload/${encodeURIComponent(sessionId)}/${index}`,
    {
      token,
      data: chunkBuffer,
      headers: { "Content-Type": contentType },
    },
  );
  // chunk upload returns {code:0,msg:""} (no data)
  parseCloudreveEnvelope(resp);
}

async function createDirectLinks({ token, uris }) {
  const resp = await crRequest("PUT", "/file/source", {
    token,
    data: { uris },
  });
  return parseCloudreveEnvelope(resp); // [{link,file_url},...]
}

async function deleteFile({
  token,
  uris,
  unlink = false,
  skip_soft_delete = true,
}) {
  const resp = await crRequest("DELETE", "/file", {
    token,
    data: { uris, unlink: !!unlink, skip_soft_delete: !!skip_soft_delete },
  });
  // returns {code:0,msg:""}
  parseCloudreveEnvelope(resp);
}

async function createDownloadUrl({ token, uris, archive = false }) {
  const resp = await crRequest("POST", "/file/url", {
    token,
    data: { uris, archive: !!archive },
  });
  return parseCloudreveEnvelope(resp); // {urls:[{url}], expires}
}

// ---- Export ----------------------------------------------------------------

async function getSiteConfigBasicUnauthed() {
  return getSiteConfigBasic();
}

module.exports = {
  CloudreveApiError,
  encryptSecret,
  decryptSecret,

  getSiteConfigBasic: getSiteConfigBasicUnauthed,
  getCaptcha,

  ensureCloudreveAccount,
  ensureAccessToken,

  createFile,
  createUploadSession,
  uploadFileChunk,
  createDirectLinks,
  createDownloadUrl,
  deleteFile,
};
