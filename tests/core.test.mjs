import assert from "node:assert/strict";
import test from "node:test";
import {
    APP_EVENT_NAMES,
    AtPetClient,
    clampTimeout,
    clip,
    mapAppEvent,
    mapCliHook,
    normalizeUrl,
    resolveSessionId,
    summarizeState,
    tokenize,
} from "../atpet/core.mjs";

const CONTEXT = { sessionId: "sess-1", agentApp: "github-copilot", source: "copilot-app" };

test("tokenize strips non-alphanumerics like At-Pet does", () => {
    assert.equal(tokenize("tool.execution_start"), "toolexecutionstart");
    assert.equal(tokenize("PreToolUse"), "pretooluse");
    assert.equal(tokenize(""), "");
    assert.equal(tokenize(null), "");
});

test("clip trims and enforces the At-Pet length limits", () => {
    assert.equal(clip("  hi  ", 10), "hi");
    assert.equal(clip("abcdef", 3), "abc");
    assert.equal(clip(null, 10), "");
});

test("every subscribed App event produces a body or is deliberately skipped", () => {
    for (const name of APP_EVENT_NAMES) {
        const body = mapAppEvent(name, {}, CONTEXT);
        assert.ok(body === null || (body.sessionId && body.event), `${name} produced an invalid body`);
    }
});

test("App thinking events map to thinking without leaking content", () => {
    for (const name of ["user.message", "assistant.turn_start", "assistant.reasoning", "assistant.message", "session.start"]) {
        const body = mapAppEvent(name, { message: "secret prompt", content: "secret" }, CONTEXT);
        assert.equal(body.event, "thinking", name);
        assert.equal(body.sessionId, "sess-1");
        assert.equal(body.message, undefined, `${name} leaked a message`);
        assert.equal(body.agentApp, "github-copilot");
    }
});

test("App tool events keep only the tool name", () => {
    const start = mapAppEvent("tool.execution_start", { toolName: "bash", toolInput: { command: "rm -rf /" } }, CONTEXT);
    assert.equal(start.event, "tool_start");
    assert.equal(start.message, "bash");

    const end = mapAppEvent("tool.execution_complete", { toolName: "bash", result: "output" }, CONTEXT);
    assert.equal(end.event, "tool_end");
    assert.equal(end.message, "bash");
});

test("App session.idle is terminal: done, or cancelled when aborted", () => {
    assert.equal(mapAppEvent("session.idle", {}, CONTEXT).event, "done");
    assert.equal(mapAppEvent("session.idle", { aborted: true }, CONTEXT).event, "cancelled");
    assert.equal(mapAppEvent("session.idle", { reason: "cancelled" }, CONTEXT).event, "cancelled");
});

test("error text is only forwarded when forwardMessages is enabled", () => {
    const quiet = mapAppEvent("session.error", { message: "boom" }, CONTEXT);
    assert.equal(quiet.event, "error");
    assert.equal(quiet.message, undefined);

    const loud = mapAppEvent("session.error", { message: "boom" }, { ...CONTEXT, forwardMessages: true });
    assert.equal(loud.event, "error");
    assert.equal(loud.message, "boom");
});

test("permission requests mark the tool that needs approval", () => {
    const body = mapAppEvent("permission.requested", { toolName: "write" }, CONTEXT);
    assert.equal(body.event, "permission_requested");
    assert.equal(body.message, "write");
});

test("unknown App events and missing session ids are not forwarded", () => {
    assert.equal(mapAppEvent("something.else", {}, CONTEXT), null);
    assert.equal(mapAppEvent("tool.execution_start", {}, { sessionId: "" }), null);
});

test("subagent events carry the parent session and a distinct id", () => {
    const body = mapAppEvent("tool.execution_start", { toolName: "bash", agentId: "sub-9" }, { ...CONTEXT, source: "copilot-app" });
    assert.equal(body.sessionId, "sub-9");
    assert.equal(body.isSubagent, true);
    assert.equal(body.parentSessionId, "sess-1");

    const flagged = mapAppEvent("assistant.message", { subagent: true }, CONTEXT);
    assert.equal(flagged.isSubagent, true);
    assert.equal(flagged.parentSessionId, "sess-1");
    assert.equal(flagged.sessionId, "sess-1:sub");
});

test("CLI hooks map onto the same event vocabulary", () => {
    const ctx = { sessionId: "cli-1", source: "copilot-cli" };
    assert.equal(mapCliHook("sessionStart", {}, ctx).event, "thinking");
    assert.equal(mapCliHook("userPromptSubmitted", {}, ctx).event, "thinking");
    assert.deepEqual(
        [mapCliHook("preToolUse", { tool_name: "shell" }, ctx).event, mapCliHook("preToolUse", { tool_name: "shell" }, ctx).message],
        ["tool_start", "shell"],
    );
    assert.equal(mapCliHook("postToolUse", { tool_name: "shell" }, ctx).event, "tool_end");
    assert.equal(mapCliHook("agentStop", {}, ctx).event, "done");
    assert.equal(mapCliHook("sessionEnd", {}, ctx).event, "session_end");
    assert.equal(mapCliHook("errorOccurred", {}, ctx).event, "error");
    assert.equal(mapCliHook("unknown", {}, ctx), null);
});

test("CLI subagent hooks are flagged", () => {
    const body = mapCliHook("subagentStart", { agent_id: "child" }, { sessionId: "cli-1" });
    assert.equal(body.isSubagent, true);
    assert.equal(body.parentSessionId, "cli-1");
    assert.equal(body.sessionId, "child");
});

test("resolveSessionId prefers config, then host, then a workspace hash", () => {
    assert.equal(resolveSessionId({ sessionId: "host" }, { sessionId: "pinned" }, "C:/repo"), "pinned");
    assert.equal(resolveSessionId({ sessionId: "host" }, {}, "C:/repo"), "host");
    const hashed = resolveSessionId({}, {}, "C:/repo");
    assert.match(hashed, /^copilot-[0-9a-f]{8}$/);
    assert.equal(hashed, resolveSessionId({}, {}, "C:/repo"), "hash must be stable");
    assert.notEqual(hashed, resolveSessionId({}, {}, "C:/other"));
});

test("normalizeUrl and clampTimeout sanitize config values", () => {
    assert.equal(normalizeUrl("http://127.0.0.1:9000/"), "http://127.0.0.1:9000");
    assert.equal(normalizeUrl("ftp://example.com"), "http://127.0.0.1:8765");
    assert.equal(normalizeUrl("nonsense"), "http://127.0.0.1:8765");
    assert.equal(clampTimeout(0), 2000);
    assert.equal(clampTimeout(5), 100);
    assert.equal(clampTimeout(999999), 30000);
});

function recordingFetch(responseBody = { ok: true }) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 200, json: async () => responseBody };
    };
    impl.calls = calls;
    return impl;
}

test("client posts normalized bodies to the At-Pet API", async () => {
    const fetchImpl = recordingFetch();
    const client = new AtPetClient({ url: "http://127.0.0.1:8765/", fetchImpl });

    await client.sendEvent({ sessionId: "s", event: "thinking" });
    await client.say("hi", 3);
    await client.animation("auto");
    await client.summon({ all: true });
    await client.state();

    assert.deepEqual(fetchImpl.calls.map((call) => call.url), [
        "http://127.0.0.1:8765/event",
        "http://127.0.0.1:8765/say",
        "http://127.0.0.1:8765/animation",
        "http://127.0.0.1:8765/summon",
        "http://127.0.0.1:8765/state",
    ]);
    assert.equal(fetchImpl.calls[0].init.method, "POST");
    assert.deepEqual(fetchImpl.calls[1].body, { text: "hi", durationSec: 3 });
    assert.deepEqual(fetchImpl.calls[3].body, { all: true });
});

test("client rejects incomplete events instead of sending them", async () => {
    const fetchImpl = recordingFetch();
    const client = new AtPetClient({ fetchImpl });
    const result = await client.sendEvent({ event: "thinking" });
    assert.equal(result.ok, false);
    assert.equal(fetchImpl.calls.length, 0);
});

test("summarizeState handles the real At-Pet /state shape", () => {
    const summary = summarizeState({
        app: "At-Pet",
        version: "1.3.0",
        pets: [{ id: "ni-shuwu", name: "ni-shuwu", animation: "tool", speech: "powershell" }],
        sessions: [
            { sessionId: "abc", agentApp: "GitHub Copilot", animation: "thinking", isSubagent: false, model: "" },
            { sessionId: "abc:sub", agentApp: "GitHub Copilot", animation: "tool", isSubagent: true },
        ],
    });
    assert.equal(summary.app, "At-Pet");
    assert.equal(summary.version, "1.3.0");
    assert.deepEqual(summary.pets, [{ id: "ni-shuwu", animation: "tool" }]);
    assert.equal(summary.sessions.length, 2);
    assert.equal(summary.sessions[1].isSubagent, true);
    assert.deepEqual(summarizeState(null), { app: "", version: "", pets: [], sessions: [] });
});

test("client never throws: transport errors and timeouts become results", async () => {
    const refused = new AtPetClient({
        fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const refusedResult = await refused.health();
    assert.equal(refusedResult.ok, false);
    assert.match(refusedResult.error, /ECONNREFUSED/);

    const timeout = new AtPetClient({
        fetchImpl: async () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; },
    });
    const timeoutResult = await timeout.health();
    assert.equal(timeoutResult.error, "timeout");

    const noFetch = new AtPetClient({ fetchImpl: null });
    assert.equal((await noFetch.health()).ok, false);
});
