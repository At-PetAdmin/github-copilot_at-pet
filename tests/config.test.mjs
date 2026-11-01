import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig, defaultConfigPaths, loadConfig } from "../atpet/config.mjs";

function fakeFs(files) {
    return (file) => {
        if (!(file in files)) throw new Error("ENOENT");
        return files[file];
    };
}

test("defaults are safe: enabled, no forwarded messages", () => {
    const config = createDefaultConfig();
    assert.equal(config.url, "http://127.0.0.1:8765");
    assert.equal(config.timeoutMs, 2000);
    assert.equal(config.agentApp, "github-copilot");
    assert.equal(config.enabled, true);
    assert.equal(config.forwardMessages, false);
    assert.equal(config.debug, false);
});

test("AT_PET_CONFIG wins over the other candidate paths", () => {
    const paths = defaultConfigPaths({
        env: { AT_PET_CONFIG: "D:/custom.json", APPDATA: "C:/AppData", USERPROFILE: "C:/Users/me" },
        moduleDir: "D:/ext",
    });
    assert.equal(paths[0], "D:/custom.json");
    assert.ok(paths.includes(path.join("D:/ext", "atpet.config.json")));
    assert.ok(paths.includes(path.join("C:/AppData", "copilot-atpet", "atpet.config.json")));
    assert.ok(paths.includes(path.join("C:/Users/me", ".copilot", "atpet.config.json")));
});

test("file config is applied and environment overrides it", () => {
    const config = loadConfig({
        paths: ["cfg.json"],
        readFile: fakeFs({
            "cfg.json": JSON.stringify({ url: "http://127.0.0.1:9001", agentApp: "custom-app", forwardMessages: true }),
        }),
        env: { AT_PET_TIMEOUT_MS: "5000", AT_PET_ENABLED: "off" },
    });
    assert.equal(config.configFile, "cfg.json");
    assert.equal(config.url, "http://127.0.0.1:9001");
    assert.equal(config.agentApp, "custom-app");
    assert.equal(config.forwardMessages, true);
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.enabled, false);
});

test("broken or missing config falls back to defaults", () => {
    const config = loadConfig({
        paths: ["missing.json", "broken.json", "array.json"],
        readFile: fakeFs({ "broken.json": "{not json", "array.json": "[]" }),
        env: {},
    });
    assert.equal(config.configFile, "");
    assert.equal(config.url, "http://127.0.0.1:8765");
    assert.equal(config.enabled, true);
});

test("environment alone is enough to configure the bridge", () => {
    const config = loadConfig({
        paths: [],
        readFile: fakeFs({}),
        env: {
            AT_PET_URL: "http://127.0.0.1:9555",
            AT_PET_SESSION_ID: "pinned",
            AT_PET_MODEL: "gpt-x",
            AT_PET_DEBUG: "1",
            AT_PET_FORWARD_MESSAGES: "yes",
        },
    });
    assert.equal(config.url, "http://127.0.0.1:9555");
    assert.equal(config.sessionId, "pinned");
    assert.equal(config.model, "gpt-x");
    assert.equal(config.debug, true);
    assert.equal(config.forwardMessages, true);
});
