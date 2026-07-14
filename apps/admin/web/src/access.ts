import { useApiQuery } from "./api";
import type { GlobalPauseState, Session } from "./types";

export function useSessionAccess() {
  const query = useApiQuery<Session>("/session", { refetchInterval: 5_000 });
  const session = query.data?.data;
  const isDemo = session?.dataMode === "demo" || session?.demo === true;
  const roleCanOperate = session?.role === "operator" || session?.role === "admin";
  const roleCanAdminister = session?.role === "admin";

  return {
    query,
    session,
    isDemo,
    ready: Boolean(session) && !query.error,
    canOperate: !isDemo && (session?.permissions?.operate ?? roleCanOperate),
    canAdminister: !isDemo && (session?.permissions?.administer ?? roleCanAdminister),
  };
}

export function useGlobalPauseState() {
  const query = useApiQuery<GlobalPauseState>("/settings/global-pause", { refetchInterval: 5_000 });
  return {
    query,
    state: query.data?.data,
    ready: Boolean(query.data?.data) && !query.error,
    paused: query.data?.data.paused ?? false,
  };
}
