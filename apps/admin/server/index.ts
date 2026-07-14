import { buildApp } from "./app.js";
import { assertSecureBind } from "./auth.js";

const host = process.env.LOOP_ADMIN_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.LOOP_ADMIN_PORT ?? 8787);
const authToken = process.env.LOOP_ADMIN_TOKEN?.trim() || undefined;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("LOOP_ADMIN_PORT must be an integer between 1 and 65535");
}

assertSecureBind(host, authToken);

const app = await buildApp({ logger: true, serveStatic: true, authToken });

try {
  await app.listen({ host, port });
  app.log.info(`Loop Engineering Admin is available at http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
