// At-Pet bridge core: payload mapping and the local HTTP client.
// Pure module (no filesystem, no process state) so the Copilot App extension and the
// Copilot CLI hook bridge share one contract and stay unit-testable.

export const DEFAULT_URL = "http://127.0.0.1:8765";
export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_AGENT_APP = "github-copilot";

// Mirrors app/main.cpp: every field At-Pet reads is clipped before it reaches the window.
const LIMITS = {
    sessionId: 256,
    agentApp: 64,
    event: 32,
    message: 180,
    model: 120,
    source: 40,
};

export function clip(value, max) {
    const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
    return text.length > max ? text.slice(0, max) : text;
}

/** At-Pet normalizes event names by dropping non-alphanumerics; match the same way. */
export function tokenize(name) {
    return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
}

export function normalizeUrl(value) {
    const text = firstString(value);
    if (!text) return DEFAULT_URL;
    try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_URL;
        return (url.origin + url.pathname).replace(/\/+$/, "") || DEFAULT_URL;
    } catch {
        return DEFAULT_URL;
    }
}

export function clampTimeout(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(Math.round(ms), 100), 30000);
}

/** Copilot App session events the extension subscribes to (SDK event names). */
export const APP_EVENT_NAMES = [
    "session.start",
    "session.end",
    "user.message",
    "assistant.turn_start",
    "assistant.reasoning",
    "assistant.message",
    "tool.execution_start",
    "tool.execution_complete",
    "session.idle",
    "session.error",
    "permission.requested",
];

const APP_RULES = new Map(Object.entries({
    sessionstart: { event: "thinking" },
    sessioncreated: { event: "thinking" },
    sessionresumed: { event: "thinking" },
    usermessage: { event: "thinking" },
    userprompt: { event: "thinking" },
    userpromptsubmitted: { event: "thinking" },
    assistantturnstart: { event: "thinking" },
    assistantreasoning: { event: "thinking" },
    assistantmessage: { event: "thinking" },
    assistantmessagecomplete: { event: "thinking" },
    toolexecutionstart: { event: "tool_start", tool: true },
    toolexecutioncomplete: { event: "tool_end", tool: true },
    toolstart: { event: "tool_start", tool: true },
    toolend: { event: "tool_end", tool: true },
    toolcomplete: { event: "tool_end", tool: true },
    permissionrequest: { event: "permission_requested" },
    permissionrequested: { event: "permission_requested" },
    sessionerror: { event: "error", message: "error" },
    error: { event: "error", message: "error" },
    sessionend: { event: "session_end" },
    sessionended: { event: "session_end" },
}));

/** Copilot CLI hook names (hook_event_name) accepted by bridge.mjs. */
export const CLI_HOOK_RULES = new Map(Object.entries({
    sessionstart: { event: "thinking" },
    sessionstarted: { event: "thinking" },
    userpromptsubmit: { event: "thinking" },
    userpromptsubmitted: { event: "thinking" },
    userprompt: { event: "thinking" },
    usermessage: { event: "thinking" },
    pretooluse: { event: "tool_start", tool: true },
    posttooluse: { event: "tool_end", tool: true },
    posttoolusefailure: { event: "error", message: "error" },
    erroroccurred: { event: "error", message: "error" },
    permissionrequest: { event: "permission_requested" },
    stop: { event: "done" },
    agentstop: { event: "done" },
    subagentstart: { event: "thinking", subagent: true },
    subagentstop: { event: "done", subagent: true },
    sessionend: { event: "session_end" },
}));

function toolNameFrom(data) {
    return firstString(
        data.toolName,
        data.tool_name,
        data.tool,
        data.name,
        data.toolCall && data.toolCall.name,
        data.tool_call && data.tool_call.name,
    );
}

function messageFrom(data) {
    return firstString(
        data.message,
        data.error,
        data.errorMessage,
        data.reason,
        data.detail,
        data.toolInput && data.toolInput.description,
    );
}

function basePayload(context) {
    const sessionId = clip(firstString(context.sessionId, context.session_id), LIMITS.sessionId);
    if (!sessionId) return null;
    return {
        sessionId,
        agentApp: clip(firstString(context.agentApp, DEFAULT_AGENT_APP), LIMITS.agentApp) || DEFAULT_AGENT_APP,
        model: clip(firstString(context.model), LIMITS.model),
        source: clip(firstString(context.source, "copilot-atpet"), LIMITS.source),
    };
}

function withSubagent(payload, data, flagged) {
    const explicitParent = firstString(data.parentSessionId, data.parent_session_id, data.parentAgentId);
    const id = firstString(data.agentId, data.agent_id, data.subagentId, data.subagent_id);
    if (!explicitParent && !flagged && !id) return payload;
    payload.isSubagent = true;
    payload.parentSessionId = clip(explicitParent || payload.sessionId, LIMITS.sessionId);
    payload.sessionId = clip(id || payload.parentSessionId + ":sub", LIMITS.sessionId);
    return payload;
}

function finalize(payload, rule, data, context) {
    payload.event = clip(rule.event, LIMITS.event);
    if (rule.tool) payload.message = clip(toolNameFrom(data), LIMITS.message);
    else if (rule.message === "error" && context.forwardMessages) payload.message = clip(messageFrom(data), LIMITS.message);
    else payload.message = clip(context.message, LIMITS.message);
    if (!payload.model) delete payload.model;
    if (!payload.message) delete payload.message;
    if (payload.parentSessionId) payload.isSubagent = true;
    return payload;
}

/**
 * Map a Copilot App session event to an At-Pet /event body.
 * Returns null when the event is not forwarded (unknown name, no session id).
 */
export function mapAppEvent(name, data, context = {}) {
    const payload = basePayload(context);
    if (!payload) return null;
    const source = data && typeof data === "object" ? data : {};
    const clean = tokenize(name);

    if (clean === "sessionidle" || clean === "sessionidleevent") {
        const aborted = source.aborted === true || source.interrupted === true ||
            source.reason === "aborted" || source.reason === "cancelled" || source.reason === "canceled";
        withSubagent(payload, source, source.isSubagent === true || source.subagent === true);
        return finalize(payload, { event: aborted ? "cancelled" : "done" }, source, context);
    }

    if (clean === "permissionrequested") {
        withSubagent(payload, source, false);
        return finalize(payload, { event: "permission_requested", tool: true }, source, context);
    }

    const rule = APP_RULES.get(clean);
    if (!rule) return null;
    withSubagent(payload, source, source.isSubagent === true || source.subagent === true);
    return finalize(payload, rule, source, context);
}

/**
 * Map a Copilot CLI hook payload to an At-Pet /event body.
 * Returns null when the hook is not forwarded.
 */
export function mapCliHook(hookName, payload, context = {}) {
    const data = payload && typeof payload === "object" ? payload : {};
    const clean = tokenize(hookName);
    const rule = CLI_HOOK_RULES.get(clean);
    if (!rule) return null;
    const body = basePayload(context);
    if (!body) return null;
    const flagged = rule.subagent === true || data.is_subagent === true || data.isSubagent === true;
    withSubagent(body, data, flagged);
    return finalize(body, rule, data, context);
}

/**
 * Stable session id: explicit config first, then whatever the host exposes,
 * then a hash of the working directory so repeats in one workspace share a session.
 */
export function resolveSessionId(session, config = {}, cwd = "") {
    const explicit = firstString(config.sessionId);
    if (explicit) return clip(explicit, LIMITS.sessionId);

    const fromSession = firstString(
        session && session.sessionId,
        session && session.session_id,
        session && session.id,
    );
    if (fromSession) return clip(fromSession, LIMITS.sessionId);

    const seed = firstString(cwd, session && session.cwd);
    return `copilot-${hashHex(seed)}`;
}

function hashHex(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/** Compact /state summary for the `atpet_status` tool. */
export function summarizeState(state) {
    const data = state && typeof state === "object" ? state : {};
    const pets = Array.isArray(data.pets)
        ? data.pets.map((pet) => ({ id: firstString(pet && pet.id, pet && pet.name), animation: firstString(pet && pet.animation) }))
        : [];
    const sessions = Array.isArray(data.sessions)
        ? data.sessions.map((session) => ({
            sessionId: firstString(session && session.sessionId),
            agentApp: firstString(session && session.agentApp),
            animation: firstString(session && session.animation),
            isSubagent: Boolean(session && session.isSubagent),
        }))
        : [];
    return {
        app: firstString(data.app),
        version: firstString(data.version),
        pets,
        sessions,
    };
}

/** Thin client for At-Pet's local API. Every call resolves; it never throws at the agent. */
export class AtPetClient {
    constructor(options = {}) {
        this.url = normalizeUrl(options.url);
        this.timeoutMs = clampTimeout(options.timeoutMs);
        this.fetch = Object.prototype.hasOwnProperty.call(options, "fetchImpl")
            ? (options.fetchImpl || null)
            : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    }

    async request(path, init = {}) {
        if (!this.fetch) return { ok: false, status: 0, error: "fetch is unavailable" };
        const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
            ? AbortSignal.timeout(this.timeoutMs)
            : undefined;
        try {
            const response = await this.fetch(`${this.url}${path}`, {
                ...init,
                signal,
                headers: { "Content-Type": "application/json", ...(init.headers || {}) },
            });
            let data = null;
            try { data = await response.json(); } catch { data = null; }
            return { ok: response.ok, status: response.status, data };
        } catch (error) {
            const name = error && error.name;
            const message = name === "TimeoutError" || name === "AbortError"
                ? "timeout"
                : String((error && error.message) || error);
            return { ok: false, status: 0, error: message };
        }
    }

    sendEvent(payload) {
        if (!payload || !payload.sessionId || !payload.event) {
            return Promise.resolve({ ok: false, status: 0, error: "sessionId and event are required" });
        }
        return this.request("/event", { method: "POST", body: JSON.stringify(payload) });
    }

    say(text, durationSec) {
        const body = { text: clip(text, 2000) };
        const seconds = Number(durationSec);
        if (Number.isFinite(seconds) && seconds > 0) body.durationSec = Math.min(seconds, 600);
        return this.request("/say", { method: "POST", body: JSON.stringify(body) });
    }

    animation(name) {
        return this.request("/animation", { method: "POST", body: JSON.stringify({ name: clip(name, 40) }) });
    }

    summon(options = {}) {
        const body = {};
        if (options.all === true) body.all = true;
        const petId = firstString(options.petId);
        if (petId) body.petId = clip(petId, 120);
        return this.request("/summon", { method: "POST", body: JSON.stringify(body) });
    }

    state() {
        return this.request("/state", { method: "GET" });
    }

    health() {
        return this.request("/health", { method: "GET" });
    }
}
