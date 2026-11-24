import type { BoardState, Device, HubEvent, PairInfo, Person } from "../shared/types";

export class SignedOut extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch (err) {
    // An expired Access session redirects cross-origin, which fetch reports as a network error.
    if (navigator.onLine) throw new SignedOut();
    throw err;
  }
  if (res.status === 401) throw new SignedOut();
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const api = {
  state: () => req<BoardState>("/api/state"),
  me: () => req<Person>("/api/me"),
  sessionEvents: (hubKey: string, before?: number) =>
    req<{ events: HubEvent[] }>(
      `/api/sessions/${encodeURIComponent(hubKey)}/events?limit=200${before ? `&before=${before}` : ""}`,
    ),
  pairInfo: (code: string) => req<PairInfo>(`/api/pair/${encodeURIComponent(code)}`),
  approve: (code: string) =>
    req<{ ok: true; machine: string }>("/api/pair/approve", { method: "POST", body: JSON.stringify({ code }) }),
  devices: () => req<{ devices: Device[] }>("/api/devices"),
  revoke: (id: string) => req<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
};
