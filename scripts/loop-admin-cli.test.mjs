import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./loop-admin-cli.mjs", import.meta.url));

test("create fails locally when no acceptance requirements are supplied", async () => {
  await assert.rejects(
    runCli(["create", "--goal", "Implement search"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /requires either --requirements FILE or --acceptance TEXT/);
      assert.doesNotMatch(error.stderr, /fetch failed/);
      return true;
    },
  );
});

test("create turns --acceptance into a requirement derived from the goal", async () => {
  const goal = "Implement searchable run history";
  const acceptanceCriteria = "Searching by run ID returns the matching persisted run.";
  const { result, request } = await captureCreate([
    "create",
    "--goal", goal,
    "--acceptance", acceptanceCriteria,
  ]);

  assert.equal(result.id, "run-from-cli");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/runs");
  assert.deepEqual(request.body.requirements, [{
    title: goal,
    description: goal,
    acceptanceCriteria,
  }]);
});

test("create forwards a non-empty --requirements JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-admin-cli-"));
  const requirementsPath = join(directory, "requirements.json");
  const requirements = [{
    title: "Search persisted runs",
    description: "Operators can find prior work without scanning every run.",
    acceptanceCriteria: "A query returns matching persisted run IDs and titles.",
  }];

  try {
    await writeFile(requirementsPath, JSON.stringify(requirements));
    const { request } = await captureCreate([
      "create",
      "--goal", "Implement searchable run history",
      "--requirements", requirementsPath,
    ]);
    assert.deepEqual(request.body.requirements, requirements);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("create rejects an empty --requirements JSON file locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-admin-cli-"));
  const requirementsPath = join(directory, "requirements.json");

  try {
    await writeFile(requirementsPath, "[]");
    await assert.rejects(
      runCli(["create", "--goal", "Implement search", "--requirements", requirementsPath]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /must contain at least one requirement/);
        assert.doesNotMatch(error.stderr, /fetch failed/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("create rejects ambiguous requirement inputs locally", async () => {
  await assert.rejects(
    runCli([
      "create",
      "--goal", "Implement search",
      "--requirements", "requirements.json",
      "--acceptance", "Search returns matching runs.",
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Use only one of --requirements FILE or --acceptance TEXT/);
      assert.doesNotMatch(error.stderr, /ENOENT|fetch failed/);
      return true;
    },
  );
});

async function captureCreate(args) {
  let resolveRequest;
  let rejectRequest;
  const requestPromise = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const server = createServer(async (incoming, response) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      resolveRequest({
        method: incoming.method,
        url: incoming.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"id":"run-from-cli"}');
    } catch (error) {
      rejectRequest(error);
      response.writeHead(500);
      response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  try {
    const execution = await runCli(args, `http://127.0.0.1:${address.port}`);
    return { result: JSON.parse(execution.stdout), request: await requestPromise };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function runCli(args, baseUrl = "http://127.0.0.1:1") {
  return execFileAsync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOP_ADMIN_URL: baseUrl,
      LOOP_ADMIN_TOKEN: "",
    },
  });
}
