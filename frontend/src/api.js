// src/api.js
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

  // Only set JSON content-type if we're sending a JSON body
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }

  if (!response.ok) {
    throw new ApiError(data.error || "Request failed", {
      status: response.status,
      data,
      path
    });
  }
  return data;
}
