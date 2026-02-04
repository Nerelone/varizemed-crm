import { ApiError } from "./errors";

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

function isJsonResponse(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json");
}

function parseRetryAfterMs(res: Response, jsonBody?: unknown) {
  const header = res.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  }

  if (jsonBody && typeof jsonBody === "object") {
    const err = (jsonBody as { error?: { retry_after_ms?: number } }).error;
    if (err?.retry_after_ms) return err.retry_after_ms;
  }

  return undefined;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers || undefined);
  const body = options.body;

  if (body !== undefined && body !== null && !(body instanceof FormData)) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }

  const init: RequestInit = {
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    ...options,
    headers,
    body: body === undefined || body === null ? undefined : body instanceof FormData ? body : JSON.stringify(body)
  };

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new ApiError(`Falha de rede: ${(error as Error)?.message || error}`, 0);
  }

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError("Não autorizado. Redirecionando para login...", 401);
  }

  if (res.status === 429) {
    let jsonBody: unknown = undefined;
    if (isJsonResponse(res)) {
      try {
        jsonBody = await res.json();
      } catch {}
    }
    const retryAfterMs = parseRetryAfterMs(res, jsonBody);
    const retryHint = retryAfterMs ? ` em ~${Math.ceil(retryAfterMs / 1000)}s` : "";
    throw new ApiError(`Muitas requisições. Tente novamente${retryHint}.`, 429, "RATE_LIMIT", retryAfterMs);
  }

  if (!res.ok) {
    let message = res.statusText || "Erro na requisição";
    let code: string | undefined;

    if (isJsonResponse(res)) {
      try {
        const json = await res.json();
        const errObj = (json as { error?: { message?: string; code?: string } }).error;
        message = errObj?.message || (json as { message?: string }).message || message;
        code = errObj?.code;
      } catch {}
    } else {
      try {
        const text = await res.text();
        if (text) message = text;
      } catch {}
    }

    throw new ApiError(`API ${res.status}: ${message}`, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  if (isJsonResponse(res)) return (await res.json()) as T;
  return (await res.text()) as T;
}
