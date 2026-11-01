#!/usr/bin/env node
// Copilot CLI hook bridge: stdin hook payload -> At-Pet /event.
//
// Usage (as configured in hooks/atpet.json):
//   node bridge.mjs preToolUse          # hook name as the argument
//   node bridge.mjs                     # hook name taken from the payload
// Flags:
//   --print            print the normalized /event body instead of posting it
//   --capture <file>   append the raw hook payload as JSONL (field calibration)
//   --hook <name>      hook name when the payload does not carry one
//   --url <base>       override the At-Pet base URL (also AT_PET_URL)
//   --strict           exit non-zero on failure (tests only; hooks must never block)
//
// Contract: always exit 0 unless --strict is passed, and finish within the hook timeout.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtPetClient, mapCliHook, normalizeUrl, resolveSessionId } from "./core.mjs";
import { loadConfig } from "./config.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STDIN_LIMIT_BYTES = 1024 * 1024;
const STDIN_IDLE_MS = 2000;

function parseArgs(argv) {
    const options = { hook: "", print: false, capture: "", url: "", strict: false, help: false, positional: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--print") options.print = true;
        else if (arg === "--strict") options.strict = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--capture") options.capture = argv[++index] || "";
        else if (arg === "--hook") options.hook = argv[++index] || "";
        else if (arg === "--url") options.url = argv[++index] || "";
        else if (!arg.startsWith("-")) options.positional.push(arg);
    }
    if (!options.hook && options.positional.length) options.hook = options.positional[0];
    return options;
}

function readStdin(limitBytes = STDIN_LIMIT_BYTES, idleMs = STDIN_IDLE_MS) {
    return new Promise((resolve) => {
        let data = "";
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(data), idleMs);
        timer.unref?.();
        try {
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (chunk) => {
                data += chunk;
                if (data.length >= limitBytes) {
                    data = data.slice(0, limitBytes);
                    finish(data);
                }
            });
            process.stdin.on("end", () => finish(data));
            process.stdin.on("error", () => finish(data));
        } catch {
            finish("");
        }
    });
}

const USAGE = `Copilot CLI -> At-Pet bridge

  node bridge.mjs [hookName] [--print] [--capture <file>] [--url <base>] [--strict]

Reads the hook payload from stdin and posts a normalized event to At-Pet.
`;

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(USAGE);
        return;
    }

    const config = loadConfig({ moduleDir: MODULE_DIR });
    if (options.url) config.url = normalizeUrl(options.url);

    const raw = await readStdin();
    let payload = {};
    try { payload = JSON.parse(raw || "{}") || {}; } catch { payload = {}; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

    if (options.capture) {
        try {
            appendFileSync(options.capture, JSON.stringify({ hook: options.hook || "", payload }) + "\n");
        } catch {}
    }

    const hookName = options.hook || payload.hook_event_name || payload.hookEventName ||
        payload.hook || payload.event_name || payload.event || "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const sessionId = resolveSessionId(
        { sessionId: payload.session_id || payload.sessionId || payload.sessionID || "" },
        config,
        cwd,
    );

    const body = mapCliHook(hookName, payload, {
        sessionId,
        agentApp: config.agentApp,
        model: payload.model || payload.model_name,
        source: "copilot-cli",
        forwardMessages: config.forwardMessages,
    });
    if (!body) return;

    if (options.print) {
        process.stdout.write(JSON.stringify(body) + "\n");
        return;
    }
    if (!config.enabled) return;

    const client = new AtPetClient({ url: config.url, timeoutMs: config.timeoutMs });
    const result = await client.sendEvent(body);
    if (!result.ok && options.strict) {
        process.stderr.write(`atpet: ${result.error || result.status}\n`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    if (process.argv.includes("--strict")) {
        process.stderr.write(`atpet: ${String((error && error.message) || error)}\n`);
        process.exitCode = 1;
    }
}).finally(() => {
    if (!process.argv.includes("--strict")) process.exitCode = 0;
});
