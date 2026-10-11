// Fake `codex app-server` for test/codex.test.ts: JSONL on stdio, replaying the scenario in FAKE_CODEX. Message shapes
// follow the codex-cli 0.162.1 protocol (only the fields the adapter reads).
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CODEX;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => send({ method, params });
const threadId = "thr-1";
const turnId = "turn-1";
const answer = (text) => ({ type: "agentMessage", id: "msg-final", text, phase: "final_answer" });
const finish = (status, items = [], error = null) =>
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, items, status, error, durationMs: 5 },
  });
const done = (text) => {
  notify("item/completed", { item: answer(text), threadId, turnId });
  finish("completed", [answer(text)]);
};

// Server request id → what to do with the client's response.
const waiting = new Map();
const ask = (id, method, params, then) => {
  waiting.set(id, then);
  send({ id, method, params: { threadId, turnId, ...params } });
};

const play = () => {
  switch (scenario) {
    case "happy":
      notify("item/completed", {
        item: { type: "agentMessage", id: "msg-1", text: "Working on it.", phase: "commentary" },
        threadId,
        turnId,
      });
      ask("u1", "item/tool/requestUserInput", { itemId: "x", questions: [] }, () =>
        done("Hello, hive!"),
      );
      break;
    case "command":
      notify("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "touch a.txt",
          status: "inProgress",
        },
        threadId,
        turnId,
      });
      ask(
        "s1",
        "item/commandExecution/requestApproval",
        { itemId: "cmd-1", command: "touch a.txt", cwd: process.cwd() },
        (r) => done(`decision: ${r.result.decision}`),
      );
      break;
    case "file":
    case "file-outside": {
      const path = scenario === "file" ? join(process.cwd(), "b.txt") : "/etc/hosts";
      notify("item/started", {
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [{ path, kind: { type: "add" }, diff: "hi\n" }],
          status: "inProgress",
        },
        threadId,
        turnId,
      });
      ask("s2", "item/fileChange/requestApproval", { itemId: "fc-1" }, (r) =>
        done(`decision: ${r.result.decision}`),
      );
      break;
    }
    case "wait":
      ask(
        "t1",
        "item/tool/call",
        { callId: "c1", tool: "hive_wait_for_reply", arguments: { requestMessageId: "m-9" } },
        () => {},
      );
      break;
    case "pass":
      ask("t2", "item/tool/call", { callId: "c2", tool: "hive_pass", arguments: {} }, () =>
        done("Not for me."),
      );
      break;
    case "skill":
    case "skill-unknown":
      ask(
        "t2",
        "item/tool/call",
        {
          callId: "c2",
          tool: "hive_skill_use",
          arguments: { name: scenario === "skill" ? "release-notes" : "missing" },
        },
        (r) => done(JSON.stringify(r.result)),
      );
      break;
    case "crash":
      process.exit(3);
      break;
    default: // "stop", "stubborn": run until interrupted (or killed)
      break;
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return waiting.get(msg.id)?.(msg);
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: { userAgent: "fake", codexHome: "/x" } });
    case "config/read":
      return send({
        id: msg.id,
        result: { config: { model: "m", mcp_servers: { figma: { env: { TOKEN: "secret-1" } } } } },
      });
    case "thread/start":
      return send({ id: msg.id, result: { thread: { id: threadId } } });
    case "turn/start":
      send({
        id: msg.id,
        result: { turn: { id: turnId, items: [], status: "inProgress", error: null } },
      });
      return play();
    case "turn/interrupt":
      if (scenario === "stubborn") return undefined;
      send({ id: msg.id, result: {} });
      return finish("interrupted");
    default:
      return undefined;
  }
});
