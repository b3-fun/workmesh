import type { BoardState, Device, HubEvent, PairInfo, Person } from "../shared/types";

export class SignedOut extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // An expired Access session answers with a redirect to the login page. With redirect: "manual" that arrives as an
  // opaque redirect instead of a CORS failure, so it can't be mistaken for the hub being down (a network error).
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "manual",
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.type === "opaqueredirect" || res.status === 401) throw new SignedOut();
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
      `/api/sessions/${encodeURIComponent(hubKey)}/events?limit=500${before ? `&before=${before}` : ""}`,
    ),
  pairInfo: (code: string) => req<PairInfo>(`/api/pair/${encodeURIComponent(code)}`),
  approve: (code: string) =>
    req<{ ok: true; machine: string }>("/api/pair/approve", { method: "POST", body: JSON.stringify({ code }) }),
  devices: () => req<{ devices: Device[] }>("/api/devices"),
  revoke: (id: string) => req<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
};
