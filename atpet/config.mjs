// Config resolution for both entry points: JSON file first, environment overrides second.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_APP, DEFAULT_TIMEOUT_MS, DEFAULT_URL, clampTimeout, firstString, normalizeUrl } from "./core.mjs";

export const APP_DATA_DIR_NAME = "copilot-atpet";

function isTruthy(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return text === "1" || text === "true" || text === "yes" || text === "on";
}

function isFalsy(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return text === "0" || text === "false" || text === "no" || text === "off";
}

export function defaultConfigPaths(options = {}) {
    const env = options.env ?? process.env;
    const home = options.homeDir ?? (firstString(env.USERPROFILE, env.HOME) || os.homedir());
    const appData = options.appDataDir ??
        (firstString(env.APPDATA) || (home ? path.join(home, "AppData", "Roaming") : ""));
    const moduleDir = options.moduleDir ?? "";
    const paths = [];
    if (firstString(env.AT_PET_CONFIG)) paths.push(env.AT_PET_CONFIG);
    if (moduleDir) paths.push(path.join(moduleDir, "atpet.config.json"));
    if (appData) paths.push(path.join(appData, APP_DATA_DIR_NAME, "atpet.config.json"));
    if (home) paths.push(path.join(home, ".copilot", "atpet.config.json"));
    return [...new Set(paths)];
}

export function createDefaultConfig() {
    return {
        url: DEFAULT_URL,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        agentApp: DEFAULT_AGENT_APP,
        enabled: true,
        sessionId: "",
        model: "",
        // Prompts, tool arguments and tool results are never forwarded. Error text is the
        // only free-form field, and only when explicitly enabled.
        forwardMessages: false,
        debug: false,
        configFile: "",
    };
}

function applyFileConfig(config, parsed) {
    if (typeof parsed.url === "string") config.url = parsed.url;
    if (parsed.timeoutMs !== undefined) config.timeoutMs = parsed.timeoutMs;
    if (typeof parsed.agentApp === "string" && parsed.agentApp.trim()) config.agentApp = parsed.agentApp.trim();
    if (typeof parsed.sessionId === "string") config.sessionId = parsed.sessionId.trim();
    if (typeof parsed.model === "string") config.model = parsed.model.trim();
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
    if (typeof parsed.forwardMessages === "boolean") config.forwardMessages = parsed.forwardMessages;
    if (typeof parsed.debug === "boolean") config.debug = parsed.debug;
}

function applyEnv(config, env) {
    if (typeof env.AT_PET_URL === "string" && env.AT_PET_URL.trim()) config.url = env.AT_PET_URL.trim();
    if (env.AT_PET_TIMEOUT_MS !== undefined) config.timeoutMs = env.AT_PET_TIMEOUT_MS;
    if (typeof env.AT_PET_AGENT_APP === "string" && env.AT_PET_AGENT_APP.trim()) config.agentApp = env.AT_PET_AGENT_APP.trim();
    if (typeof env.AT_PET_SESSION_ID === "string" && env.AT_PET_SESSION_ID.trim()) config.sessionId = env.AT_PET_SESSION_ID.trim();
    if (typeof env.AT_PET_MODEL === "string" && env.AT_PET_MODEL.trim()) config.model = env.AT_PET_MODEL.trim();
    if (isFalsy(env.AT_PET_ENABLED)) config.enabled = false;
    else if (isTruthy(env.AT_PET_ENABLED)) config.enabled = true;
    if (isTruthy(env.AT_PET_FORWARD_MESSAGES)) config.forwardMessages = true;
    else if (isFalsy(env.AT_PET_FORWARD_MESSAGES)) config.forwardMessages = false;
    if (isTruthy(env.AT_PET_DEBUG)) config.debug = true;
}

export function loadConfig(options = {}) {
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? ((file) => readFileSync(file, "utf8"));
    const config = createDefaultConfig();
    const paths = options.paths ?? defaultConfigPaths(options);

    for (const file of paths) {
        let text = "";
        try { text = readFile(file); } catch { continue; }
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { continue; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        config.configFile = file;
        applyFileConfig(config, parsed);
        break;
    }

    applyEnv(config, env);
    config.url = normalizeUrl(config.url);
    config.timeoutMs = clampTimeout(config.timeoutMs);
    if (!firstString(config.agentApp)) config.agentApp = DEFAULT_AGENT_APP;
    return config;
}
