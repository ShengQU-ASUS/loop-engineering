import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { mockFor } from "./mock-data";

export interface ApiEnvelope<T> {
  data: T;
  source: "api" | "demo";
  fallbackReason: string | null;
}

const stateOverride = () => new URLSearchParams(window.location.search).get("state");

const normalize = <T,>(value: unknown): T => {
  if (value && typeof value === "object" && "items" in value) return (value as { items: T }).items;
  if (value && typeof value === "object" && "data" in value) return (value as { data: T }).data;
  return value as T;
};

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const forced = stateOverride();
  if (forced === "error") throw new Error("The API returned a simulated error. Remove ?state=error to reconnect.");
  if (forced === "loading") await new Promise((resolve) => window.setTimeout(resolve, 60_000));

  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? (body as { error?: { message?: string } }).error?.message
        : null;
      throw new Error(message || `${response.status} ${response.statusText}`);
    }
    return { data: normalize<T>(body), source: "api", fallbackReason: null };
  } catch (error) {
    if (init?.method && init.method !== "GET") throw error;
    if (new URLSearchParams(window.location.search).get("demo") !== "1") throw error;
    const fallback = mockFor(path);
    if (fallback === null) throw error;
    const data = forced === "empty" && Array.isArray(fallback) ? [] : fallback;
    return {
      data: normalize<T>(data),
      source: "demo",
      fallbackReason: error instanceof Error ? error.message : "API unavailable",
    };
  }
}

export function useApiQuery<T>(path: string, options?: { refetchInterval?: number | false }): UseQueryResult<ApiEnvelope<T>, Error> {
  return useQuery({
    queryKey: ["api", path],
    queryFn: () => apiRequest<T>(path, { method: "GET" }),
    retry: false,
    refetchInterval: options?.refetchInterval,
  });
}

export async function apiMutation<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const response = await apiRequest<T>(path, { method, body: JSON.stringify(body) });
  return response.data;
}
