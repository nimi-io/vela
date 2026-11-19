export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

let environmentId: string | null = null;
export function setEnvironment(id: string | null) {
  environmentId = id;
}
export function currentEnvironment() {
  return environmentId;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  if (environmentId && path.startsWith("/v1")) headers["X-Vela-Environment"] = environmentId;
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized?.();
    throw new ApiError(res.status, body?.error?.type ?? "error", body?.error?.messages?.join(" ") ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/** Most endpoints wrap results in { data }. */
export async function get<T = any>(path: string): Promise<T> {
  return (await api<{ data: T }>(path)).data;
}
export async function post<T = any>(path: string, json?: unknown): Promise<T> {
  return (await api<{ data: T }>(path, { method: "POST", json: json ?? {} }))?.data;
}
export async function put<T = any>(path: string, json?: unknown): Promise<T> {
  return (await api<{ data: T }>(path, { method: "PUT", json: json ?? {} }))?.data;
}
export async function patch<T = any>(path: string, json?: unknown): Promise<T> {
  return (await api<{ data: T }>(path, { method: "PATCH", json: json ?? {} }))?.data;
}
export async function del(path: string): Promise<void> {
  await api(path, { method: "DELETE" });
}

/** PUT a file to a presigned URL with progress. */
export function uploadFile(url: string, file: File, onProgress: (p: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}). Check the bucket's CORS settings.`)));
    xhr.onerror = () => reject(new Error("Upload failed: network error or bucket CORS not configured"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
