// src/api.js
// Central API client + token storage.

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export function getToken() {
  return localStorage.getItem("token");
}

export function setToken(token) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

export function getUser() {
  const raw = localStorage.getItem("user");
  return raw ? JSON.parse(raw) : null;
}

export function setUser(user) {
  localStorage.setItem("user", JSON.stringify(user));
}

export function clearUser() {
  localStorage.removeItem("user");
}

/**
 * ApiError preserves HTTP status and the parsed error payload, so UI can branch
 * on status codes like 401 vs 428 (captcha required) vs 500.
 */
export class ApiError extends Error {
  constructor(message, { status, data, path } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.path = path;
  }
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };

  // Only set JSON content-type when sending a JSON body.
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  if (!resp.ok) {
    throw new ApiError(data.error || "Request failed", {
      status: resp.status,
      data,
      path,
    });
  }

  return data;
}
