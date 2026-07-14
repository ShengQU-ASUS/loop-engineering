import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Role } from "@loop-engineering/control-plane";
import { HttpError } from "./errors.js";

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function actorFromRequest(request: FastifyRequest, enableTestHeaders = false): Actor {
  if (!enableTestHeaders) {
    return { id: "local-user", name: "Local administrator", role: "admin" };
  }
  const requestedRole = request.headers["x-loop-role"];
  const role: Role = requestedRole === "viewer" || requestedRole === "operator" || requestedRole === "admin"
    ? requestedRole
    : "admin";
  const requestedActor = request.headers["x-loop-actor"];
  const id = typeof requestedActor === "string" && requestedActor.trim() ? requestedActor.trim() : "local-user";
  return { id, name: id === "local-user" ? "Local administrator" : id, role };
}

export function requireRole(actor: Actor, minimum: Role): void {
  if (ROLE_RANK[actor.role] < ROLE_RANK[minimum]) {
    throw new HttpError(403, "FORBIDDEN", `${minimum} role required`);
  }
}

export function assertSecureBind(host: string, token: string | undefined): void {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  if (!loopback && !token?.trim()) {
    throw new Error("LOOP_ADMIN_TOKEN is required when LOOP_ADMIN_HOST is not a loopback address");
  }
}

export function requireBearerToken(request: FastifyRequest, expectedToken: string): void {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  if (!supplied || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw new HttpError(401, "UNAUTHORIZED", "A valid bearer token is required");
  }
}
