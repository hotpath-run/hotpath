import { API_BASE } from "./config.js";

export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** POST JSON to a hotpath.run edge function; a non-2xx answer throws HttpError (a network failure throws as is). */
export async function post(
  fetchImpl: Fetch,
  fn: "cli-auth" | "cli-sync",
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${API_BASE}/functions/v1/${fn}`, {
    method: "POST",
    // The functions are public (they check the user's own token), so the CLI
    // ships no project key at all: only the user's token, when there is one.
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    throw new HttpError(
      res.status,
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  }
  return data;
}
