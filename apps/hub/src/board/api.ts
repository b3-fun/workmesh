import type { BoardState, Device, HubEvent, PairInfo, Person } from "../shared/types";
import { ApiError } from "./b3os/api/client";

export { ApiError };
export class SignedOut extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // An expired Access session answers with a redirect to the login page. With redirect: "manual" that arrives as an
  // opaque redirect instead of a CORS failure, so it can't be mistaken for the hub being down (a network error).
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch {
    throw new ApiError({ status: 0, code: "network", title: "", detail: "The hub did not answer", requestId: null, retryAfterS: null });
  }
  if (res.type === "opaqueredirect" || res.status === 401) throw new SignedOut();
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError({
      status: res.status,
      code: String(res.status),
      title: "",
      detail: body.error ? body.error.charAt(0).toUpperCase() + body.error.slice(1) : `The hub answered ${res.status}`,
      // Cloudflare's id for the request, the one to quote.
      requestId: res.headers.get("cf-ray"),
      retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : null,
    });
  }
  return body;
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
