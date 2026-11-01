#!/usr/bin/env node
// GitHub Copilot App extension: live session events -> At-Pet desktop pet.
//
// Install: copy this folder to <repo>/.github/extensions/atpet/ and reload extensions
// in the Copilot App. At-Pet must be running (its local API listens on 127.0.0.1:8765).
//
// Design rules:
//   - Never block or fail the agent: every At-Pet call resolves, errors are dropped.
//   - Forward only normalized fields (session, event, tool name, model, subagent markers).
//     Prompts and tool output never leave the extension.
//   - Load lazily-safe: if the SDK is missing the process exits without touching the repo.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { APP_EVENT_NAMES, AtPetClient, clip, mapAppEvent, resolveSessionId, summarizeState } from "./core.mjs";
import { loadConfig } from "./config.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "copilot-app";

const config = loadConfig({ moduleDir: MODULE_DIR });
const client = new AtPetClient({ url: config.url, timeoutMs: config.timeoutMs });

let log = async () => {};
let closing = false;

function offline(result) {
    const reason = result && (result.error || (result.status ? `HTTP ${result.status}` : "no response"));
    return {
        textResultForLlm: `At-Pet 没有响应（${reason}）。请先启动 At-Pet 桌面宠物，或检查 ${config.url}。`,
        resultType: "failure",
    };
}

const tools = [
    {
        name: "atpet_say",
        description: "让 At-Pet 桌面宠物显示一段气泡文字。",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "要说的话，最多 2000 字符" },
                durationSec: { type: "number", description: "气泡停留秒数，可选" },
            },
            required: ["text"],
        },
        handler: async (ctx) => {
            const text = clip(ctx && ctx.input && ctx.input.text, 2000);
            if (!text) return { textResultForLlm: "text 不能为空。", resultType: "failure" };
            const result = await client.say(text, ctx.input.durationSec);
            return result.ok ? "桌宠已经说话了。" : offline(result);
        },
    },
    {
        name: "atpet_animation",
        description: "切换 At-Pet 桌面宠物的动画；传 auto 恢复自动行为。",
        parameters: {
            type: "object",
            properties: { name: { type: "string", description: "动画名，例如 thinking / review / error / auto" } },
            required: ["name"],
        },
        handler: async (ctx) => {
            const name = clip(ctx && ctx.input && ctx.input.name, 40);
            if (!name) return { textResultForLlm: "name 不能为空。", resultType: "failure" };
            const result = await client.animation(name);
            return result.ok ? `已切换到动画 ${name}。` : offline(result);
        },
    },
    {
        name: "atpet_summon",
        description: "召唤或切换 At-Pet 桌面宠物窗口。all=true 时召唤桌宠库中的全部桌宠。",
        parameters: {
            type: "object",
            properties: {
                all: { type: "boolean", description: "是否召唤全部桌宠" },
                petId: { type: "string", description: "要切换到的桌宠 id，可选" },
            },
        },
        handler: async (ctx) => {
            const input = (ctx && ctx.input) || {};
            const result = await client.summon({ all: input.all === true, petId: input.petId });
            return result.ok ? "召唤请求已发送。" : offline(result);
        },
    },
    {
        name: "atpet_status",
        description: "读取 At-Pet 当前状态（运行中的应用、桌宠、会话列表）。",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            const result = await client.state();
            if (!result.ok) return offline(result);
            return JSON.stringify(summarizeState(result.data));
        },
    },
];

const session = await joinSession({ tools });

if (session && typeof session.log === "function") {
    log = async (text) => {
        try { await session.log(String(text)); } catch {}
    };
}

const sessionId = resolveSessionId(session, config, process.cwd());
const context = () => ({
    sessionId,
    agentApp: config.agentApp,
    model: config.model,
    source: SOURCE,
    forwardMessages: config.forwardMessages,
});

async function forward(name, event) {
    if (!config.enabled) return;
    try {
        const data = event && typeof event === "object" ? (event.data || event.payload || event) : {};
        const payload = mapAppEvent(name, data, context());
        if (!payload) return;
        const result = await client.sendEvent(payload);
        if (config.debug) {
            await log(`atpet ${payload.event} ${payload.sessionId}: ${result.ok ? "ok" : result.error || result.status}`);
        }
    } catch (error) {
        if (config.debug) await log(`atpet forward failed: ${String((error && error.message) || error)}`);
    }
}

for (const name of APP_EVENT_NAMES) {
    try {
        session.on(name, (event) => { void forward(name, event); });
    } catch {
        // Unknown event name on this SDK version: skip it rather than fail the extension.
    }
}

async function shutdown() {
    if (closing) return;
    closing = true;
    try {
        await client.sendEvent({
            sessionId,
            agentApp: config.agentApp,
            event: "session_end",
            source: SOURCE,
        });
    } catch {}
}

process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.on("beforeExit", () => { void shutdown(); });

if (config.debug) {
    await log(`atpet bridge ready: url=${config.url} session=${sessionId} agentApp=${config.agentApp}`);
}
