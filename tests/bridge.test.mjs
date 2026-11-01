import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "atpet", "bridge.mjs");

function runBridge(args, stdin = "", env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BRIDGE, ...args], {
            cwd: ROOT,
            env: {
                ...process.env,
                AT_PET_CONFIG: path.join(ROOT, "tests", ".no-such-config.json"),
                AT_PET_SESSION_ID: "",
                AT_PET_MODEL: "",
                AT_PET_DEBUG: "",
                AT_PET_FORWARD_MESSAGES: "",
                ...env,
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin);
    });
}

async function startAtPet() {
    const requests = [];
    const server = createServer((request, response) => {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
            requests.push({
                method: request.method,
                url: request.url,
                body: raw ? JSON.parse(raw) : null,
            });
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test("--print emits the normalized body without contacting At-Pet", async () => {
    const result = await runBridge(["preToolUse", "--print"], JSON.stringify({
        hook_event_name: "preToolUse",
        session_id: "cli-session",
        cwd: "C:/repo",
        tool_name: "shell",
        tool_input: { command: "npm test" },
    }));
    assert.equal(result.code, 0);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.sessionId, "cli-session");
    assert.equal(body.event, "tool_start");
    assert.equal(body.message, "shell");
    assert.equal(body.source, "copilot-cli");
    assert.equal(body.agentApp, "github-copilot");
    assert.equal(JSON.stringify(body).includes("npm test"), false, "tool arguments must not leak");
});

test("posts one event per hook to the At-Pet API", async () => {
    const server = await startAtPet();
    try {
        const result = await runBridge(["userPromptSubmitted", "--url", server.url], JSON.stringify({
            session_id: "cli-42",
            prompt: "do not forward me",
        }));
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "POST");
        assert.equal(server.requests[0].url, "/event");
        assert.equal(server.requests[0].body.event, "thinking");
        assert.equal(server.requests[0].body.sessionId, "cli-42");
        assert.equal(JSON.stringify(server.requests[0].body).includes("do not forward me"), false);
    } finally {
        await server.close();
    }
});

test("hook name falls back to the payload when no argument is given", async () => {
    const server = await startAtPet();
    try {
        const result = await runBridge(["--url", server.url], JSON.stringify({
            hook_event_name: "agentStop",
            session_id: "cli-7",
        }));
        assert.equal(result.code, 0);
        assert.equal(server.requests[0].body.event, "done");
    } finally {
        await server.close();
    }
});

test("unknown hooks post nothing but still exit 0", async () => {
    const server = await startAtPet();
    try {
        const result = await runBridge(["someUnknownHook", "--url", server.url], JSON.stringify({ session_id: "cli-8" }));
        assert.equal(result.code, 0);
        assert.equal(server.requests.length, 0);
    } finally {
        await server.close();
    }
});

test("a missing At-Pet never fails the hook", async () => {
    const probe = await startAtPet();
    const deadUrl = probe.url;
    await probe.close();

    const result = await runBridge(["preToolUse", "--url", deadUrl], JSON.stringify({ session_id: "cli-9" }));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const strict = await runBridge(["preToolUse", "--url", deadUrl, "--strict"], JSON.stringify({ session_id: "cli-9" }));
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /atpet:/);
});

test("invalid JSON on stdin is tolerated", async () => {
    const server = await startAtPet();
    try {
        const result = await runBridge(["sessionStart", "--url", server.url], "not json");
        assert.equal(result.code, 0);
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].body.event, "thinking");
        assert.match(server.requests[0].body.sessionId, /^copilot-[0-9a-f]{8}$/);
    } finally {
        await server.close();
    }
});

test("AT_PET_ENABLED=0 disables forwarding", async () => {
    const server = await startAtPet();
    try {
        const result = await runBridge(["postToolUse", "--url", server.url], JSON.stringify({ session_id: "cli-10" }), {
            AT_PET_ENABLED: "0",
        });
        assert.equal(result.code, 0);
        assert.equal(server.requests.length, 0);
    } finally {
        await server.close();
    }
});
