import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  APPROVAL_STATUSES,
  RUN_STATUSES,
  approvalDecisionSchema,
  checkerVerdictSchema,
  createRunSchema,
  eventInputSchema,
  runtimeFactSchema,
  runActionSchema,
  stageTransitionSchema,
  type RunStatus,
} from "@loop-engineering/control-plane";
import { actorFromRequest, requireBearerToken, requireRole } from "./auth.js";
import { openDatabase } from "./database.js";
import { HttpError } from "./errors.js";
import { encodeSse, EventHub } from "./event-hub.js";
import { ensureBaseData, getWorkspaceDataMode, seedDemoData } from "./seed.js";
import { ControlPlaneStore } from "./store.js";

const DEFAULT_STAGES = [
  { key: "trigger", name: "Trigger", role: "system" },
  { key: "intake", name: "Intake & requirements", role: "triage" },
  { key: "state", name: "Load state & constraints", role: "system" },
  { key: "budget", name: "Budget guard", role: "system" },
  { key: "worktree", name: "Isolated worktree", role: "system" },
  { key: "maker", name: "Maker implementation", role: "maker" },
  { key: "verify", name: "Deterministic verification", role: "system" },
  { key: "checker", name: "Independent checker", role: "checker" },
  { key: "human", name: "Human gate", role: "human" },
  { key: "apply", name: "Apply or deliver", role: "system" },
  { key: "final-verify", name: "Final verification", role: "checker" },
  { key: "persist", name: "Persist state", role: "system" },
] as const;

const runTransitionSchema = z.object({
  status: z.enum(RUN_STATUSES),
  reason: z.string().trim().max(2_000).optional(),
  expectedStatus: z.enum(RUN_STATUSES).optional(),
  blockedOwner: z.string().trim().max(200).optional(),
  unblockCondition: z.string().trim().max(2_000).optional(),
});

const globalPauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().min(1).max(4_000),
  expectedVersion: z.number().int().positive(),
});

const checkerVerdictRequestSchema = checkerVerdictSchema.extend({
  requirementResults: z.array(z.object({
    requirementId: z.string().trim().min(1),
    status: z.enum(["pass", "fail", "missing"]),
    evidenceIds: z.array(z.string().trim().min(1)),
    note: z.string().trim().max(4_000).default(""),
  })).default([]),
});

export interface BuildAppOptions {
  database?: DatabaseSync;
  databasePath?: string;
  demo?: boolean;
  logger?: boolean;
  serveStatic?: boolean;
  enableTestAuthHeaders?: boolean;
  authToken?: string;
  demoRunSourceMode?: "managed" | "snapshot";
  e2eFixture?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const ownsDatabase = !options.database;
  const database = options.database ?? openDatabase(options.databasePath);
  const eventHub = new EventHub();
  const store = new ControlPlaneStore(database, eventHub);
  const getActor = (request: FastifyRequest) => actorFromRequest(request, options.enableTestAuthHeaders === true);
  if (options.e2eFixture && process.env.NODE_ENV !== "test") {
    if (ownsDatabase) database.close();
    throw new Error("Writable E2E fixtures require NODE_ENV=test");
  }
  const demoRequested = options.e2eFixture || (options.demo ?? process.env.LOOP_ADMIN_DEMO === "1");
  let dataMode: "operational" | "demo";
  try {
    const existingMode = getWorkspaceDataMode(database);
    if (demoRequested && existingMode === "operational") {
      throw new Error("Refusing demo mode for an operational database; use a separate LOOP_ADMIN_DB");
    }
    if (demoRequested) seedDemoData(database, { runSourceMode: options.e2eFixture ? "managed" : options.demoRunSourceMode });
    if (options.e2eFixture) {
      database.prepare("UPDATE settings SET value = 'operational' WHERE key = 'workspace_data_mode'").run();
    }
    dataMode = ensureBaseData(database, demoRequested && !options.e2eFixture ? "demo" : "operational");
  } catch (error) {
    if (ownsDatabase) database.close();
    throw error;
  }
  const demo = dataMode === "demo";
  const demoReadOnly = demo && options.demoRunSourceMode !== "managed";

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) callback(null, true);
      else callback(new Error("Only loopback browser origins are allowed"), false);
    },
    allowedHeaders: ["authorization", "content-type", "last-event-id", "x-loop-actor", "x-loop-role"],
  });

  if (options.authToken) {
    app.addHook("onRequest", async (request) => requireBearerToken(request, options.authToken as string));
  }
  if (demoReadOnly) {
    app.addHook("preHandler", async (request) => {
      if (request.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        throw new HttpError(409, "DEMO_READ_ONLY", "Sample workspace data is read-only; start without --demo for real work");
      }
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues },
      });
      return;
    }
    request.log.error(error);
    void reply.status((error as { statusCode?: number }).statusCode ?? 500).send({
      error: { code: "INTERNAL_ERROR", message: (error as Error).message || "Internal server error" },
    });
  });

  app.get("/api/health", async () => ({ status: "ok", database: "connected", time: new Date().toISOString() }));

  app.get("/api/session", async (request) => {
    const actor = getActor(request);
    return {
      role: actor.role,
      user: { id: actor.id, name: actor.name },
      demo,
      dataMode,
      localOnly: true,
      authMode: options.authToken ? "bearer" : "local",
      permissions: {
        read: true,
        operate: !demoReadOnly && (actor.role === "operator" || actor.role === "admin"),
        administer: !demoReadOnly && actor.role === "admin",
      },
    };
  });

  app.get("/api/overview", async () => store.overview());
  app.get("/api/settings/global-pause", async () => store.getGlobalPause());
  app.patch("/api/settings/global-pause", async (request) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    return store.setGlobalPause(globalPauseSchema.parse(request.body), actor);
  });
  app.get("/api/loops", async () => store.listLoops());
  app.get<{ Params: { id: string } }>("/api/loops/:id", async (request) => store.getLoop(request.params.id));

  app.get<{ Querystring: { status?: string; loopId?: string; q?: string; limit?: string; offset?: string } }>(
    "/api/runs",
    async (request) => store.listRuns({
      status: request.query.status,
      loopId: request.query.loopId,
      query: request.query.q,
      limit: parseInteger(request.query.limit),
      offset: parseInteger(request.query.offset),
    }),
  );

  app.post("/api/runs", async (request, reply) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const body = isObject(request.body) ? request.body : {};
    const loops = store.listLoops();
    const loop = loops.find((item) => item.id === body.loopId)
      ?? loops.find((item) => item.id === "general-development")
      ?? loops[0];
    const parsed = createRunSchema.parse({
      ...body,
      loopId: body.loopId ?? loop?.id,
      automationLevel: body.automationLevel ?? loop?.automationLevel ?? "L2",
      risk: body.risk ?? loop?.risk ?? "medium",
      sourceMode: body.sourceMode ?? "managed",
      stages: body.stages ?? DEFAULT_STAGES,
      budget: body.budget ?? {
        tokenLimit: 120_000,
        costLimitUsd: 25,
        iterationLimit: 12,
        warningPercent: 80,
      },
    });
    return reply.status(201).send(store.createRun(parsed, actor));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    const actor = getActor(request);
    const detail = store.getRunDetail(request.params.id);
    if (actor.role !== "admin") {
      detail.artifacts = detail.artifacts.map((artifact) =>
        artifact.sensitivity === "restricted" ? { ...artifact, uri: "[restricted]" } : artifact);
    }
    return detail;
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/actions", async (request) => {
    const actor = getActor(request);
    const input = runActionSchema.parse(request.body);
    requireRole(actor, input.action === "override_breaker" ? "admin" : "operator");
    return store.applyRunAction(request.params.id, input, actor);
  });

  app.patch<{ Params: { id: string } }>("/api/runs/:id/status", async (request) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const input = runTransitionSchema.parse(request.body);
    return store.transitionRun(request.params.id, input, actor);
  });

  app.patch<{ Params: { runId: string; stageId: string } }>(
    "/api/runs/:runId/stages/:stageId",
    async (request) => {
      const actor = getActor(request);
      requireRole(actor, "operator");
      const input = stageTransitionSchema.parse(request.body);
      return store.transitionStage(request.params.runId, request.params.stageId, input.status, input.reason, actor);
    },
  );

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/runtime-facts", async (request, reply) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const receipt = store.ingestRuntimeFact(request.params.runId, runtimeFactSchema.parse(request.body), actor);
    return reply.status(receipt.idempotent ? 200 : 201).send(receipt);
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/checker-verdicts", async (request, reply) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const input = checkerVerdictRequestSchema.parse(request.body);
    return reply.status(201).send(store.submitCheckerVerdict(request.params.runId, input, actor));
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/runs/:id/events",
    async (request) => store.listEvents({
      runId: request.params.id,
      after: parseInteger(request.query.after),
      limit: parseInteger(request.query.limit),
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/runs/:id/events/page",
    async (request) => store.getEventPage(
      request.params.id,
      parseInteger(request.query.after) ?? 0,
      parseInteger(request.query.limit) ?? 200,
    ),
  );

  app.get<{
    Params: { id: string };
    Querystring: { replayOnly?: string; after?: string };
  }>("/api/runs/:id/events/stream", async (request, reply) => {
    const header = request.headers["last-event-id"];
    const headerLastId = Array.isArray(header) ? header[0] : header;
    const rawLastId = headerLastId === undefined || headerLastId === "" ? request.query.after : headerLastId;
    const lastId = rawLastId === undefined || rawLastId === "" ? 0 : Number(rawLastId);
    if (!Number.isInteger(lastId) || lastId < 0) {
      throw new HttpError(400, "INVALID_LAST_EVENT_ID", "Last-Event-ID or after must be a non-negative sequence number");
    }

    const bounds = store.getEventBounds(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    let cursor = lastId;
    let replayFrom = lastId;
    let replaying = true;
    const pending: ReturnType<typeof store.listEvents> = [];
    const send = (event: ReturnType<typeof store.listEvents>[number]) => {
      if (event.sequence <= cursor || reply.raw.destroyed) return;
      reply.raw.write(encodeSse(event));
      cursor = event.sequence;
    };
    const unsubscribe = eventHub.subscribe(request.params.id, (event) => {
      if (replaying) pending.push(event);
      else send(event);
    });

    if (bounds.first !== null && lastId > 0 && bounds.first > lastId + 1) {
      reply.raw.write(`event: stream-gap\ndata: ${JSON.stringify({ expected: lastId + 1, availableFrom: bounds.first })}\n\n`);
    } else if (bounds.last !== null && lastId > bounds.last) {
      reply.raw.write(`event: stream-gap\ndata: ${JSON.stringify({ expected: lastId + 1, availableThrough: bounds.last, resetTo: bounds.last })}\n\n`);
      cursor = bounds.last;
      replayFrom = bounds.last;
    }
    let replayCursor = replayFrom;
    while (true) {
      const batch = store.listEvents({ runId: request.params.id, after: replayCursor, through: bounds.last ?? undefined, limit: 2_000 });
      for (const event of batch) send(event);
      if (batch.length < 2_000) break;
      replayCursor = batch[batch.length - 1].sequence;
    }
    replaying = false;
    for (const event of pending.sort((a, b) => a.sequence - b.sequence)) send(event);

    if (request.query.replayOnly === "true" || request.query.replayOnly === "1") {
      unsubscribe();
      reply.raw.end();
      return;
    }

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{ Querystring: { runId?: string; after?: string; limit?: string } }>("/api/events", async (request) =>
    store.listEvents({
      runId: request.query.runId,
      after: parseInteger(request.query.after),
      limit: parseInteger(request.query.limit),
    }));

  app.post("/api/events", async (request, reply) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const input = eventInputSchema.parse(request.body);
    return reply.status(201).send(store.ingestEvent({ ...input, actor: actor.id }, actor));
  });

  app.get<{ Querystring: { status?: string } }>("/api/approvals", async (request) => {
    if (request.query.status && !APPROVAL_STATUSES.includes(request.query.status as never)) {
      throw new HttpError(400, "VALIDATION_ERROR", `Unknown approval status '${request.query.status}'`);
    }
    return store.listApprovals(request.query.status);
  });

  const decideApproval = async (request: any) => {
    const actor = getActor(request);
    requireRole(actor, "operator");
    const input = approvalDecisionSchema.parse(request.body);
    return store.decideApproval(request.params.id, input, actor);
  };
  app.patch<{ Params: { id: string } }>("/api/approvals/:id/decision", decideApproval);
  app.post<{ Params: { id: string } }>("/api/approvals/:id/decision", decideApproval);

  app.get("/api/agents", async () => store.listAgents());
  app.get<{ Querystring: { runId?: string } }>("/api/worktrees", async (request) => store.listWorktrees(request.query.runId));
  app.get<{ Querystring: { runId?: string } }>("/api/artifacts", async (request) => {
    const actor = getActor(request);
    return store.listArtifacts(request.query.runId).map((artifact) =>
      artifact.sensitivity === "restricted" && actor.role !== "admin"
        ? { ...artifact, uri: "[restricted]" }
        : artifact);
  });
  app.get<{ Querystring: { runId?: string; limit?: string } }>("/api/audit", async (request) =>
    store.listAudit(request.query.runId, parseInteger(request.query.limit) ?? 250));

  if (options.serveStatic) {
    const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
    if (existsSync(resolve(staticRoot, "index.html"))) {
      await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
      });
    }
  }

  app.addHook("onClose", async () => {
    if (ownsDatabase) database.close();
  });
  return app;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(400, "VALIDATION_ERROR", `'${value}' is not a non-negative integer`);
  return number;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
