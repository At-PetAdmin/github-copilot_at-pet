#!/usr/bin/env node
// Installer for the Copilot -> At-Pet bridge.
//
//   node scripts/install.mjs app  [--repo <dir>] [--name atpet]
//   node scripts/install.mjs cli  [--repo <dir>] [--dir <dir>] [--no-hooks]
//   node scripts/install.mjs doctor [--repo <dir>]
//
// app:    copy the extension folder into <repo>/.github/extensions/<name>/ (Copilot App).
// cli:    copy the bridge folder under %USERPROFILE%\.copilot\atpet-bridge\ and write
//         hooks/atpet.json pointing at the absolute bridge path.
// doctor: print the resolved config, paths and At-Pet reachability.

import { cpSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtPetClient } from "../atpet/core.mjs";
import { loadConfig } from "../atpet/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "atpet");

// Hook names shipped by the Copilot CLI and already exercised by At-Pet's own integration.
const HOOK_EVENTS = [
    "sessionStart",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "errorOccurred",
    "agentStop",
    "sessionEnd",
];

function parseArgs(argv) {
    const args = { command: argv[0] || "doctor", repo: process.cwd(), dir: "", name: "atpet", hooks: true };
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") args.repo = path.resolve(argv[++index] || ".");
        else if (arg === "--dir") args.dir = path.resolve(argv[++index] || ".");
        else if (arg === "--name") args.name = argv[++index] || "atpet";
        else if (arg === "--no-hooks") args.hooks = false;
    }
    return args;
}

function copyBridge(target) {
    mkdirSync(target, { recursive: true });
    cpSync(SOURCE_DIR, target, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".git",
    });
    return target;
}

function hookCommand(bridgePath, hookName) {
    const winPath = bridgePath.replace(/"/g, '\\"');
    return {
        type: "command",
        bash: `node "${winPath.replace(/\\/g, "/")}" ${hookName}`,
        powershell: `node "${winPath}" ${hookName}`,
        timeoutSec: 10,
    };
}

export function buildHooksConfig(bridgePath) {
    const hooks = {};
    for (const name of HOOK_EVENTS) hooks[name] = [hookCommand(bridgePath, name)];
    return { version: 1, hooks };
}

function writeHooksFile(file, bridgePath) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeFileSync(file, JSON.stringify(buildHooksConfig(bridgePath), null, 2) + "\n", "utf8");
    return file;
}

function homeDir() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function installApp(args) {
    const target = path.join(args.repo, ".github", "extensions", args.name);
    copyBridge(target);
    const entry = path.join(target, "extension.mjs");
    console.log(`已安装 Copilot App 扩展：${target}`);
    console.log(`入口文件：${entry}`);
    if (!existsSync(path.join(args.repo, ".github", "extensions"))) {
        console.log("提示：目录是新建的，重启 Copilot App 后再重载扩展。");
    }
    console.log("下一步：在 Copilot App 中重载扩展，并确保 At-Pet 正在运行。");
}

function installCli(args) {
    const target = args.dir || path.join(homeDir(), ".copilot", "atpet-bridge");
    copyBridge(target);
    const bridgePath = path.join(target, "bridge.mjs");
    console.log(`已安装 CLI 桥接脚本：${bridgePath}`);
    if (!args.hooks) return;
    const hooksFile = path.join(args.repo, ".github", "hooks", "atpet.json");
    writeHooksFile(hooksFile, bridgePath);
    console.log(`已写入仓库级 hooks 配置：${hooksFile}`);
    console.log("如需用户级（所有项目生效），把它复制到 %USERPROFILE%\\.copilot\\hooks\\atpet.json。");
}

async function doctor(args) {
    const config = loadConfig({ moduleDir: SOURCE_DIR });
    console.log(`配置文件：${config.configFile || "(未找到，使用默认值)"}`);
    console.log(`At-Pet 地址：${config.url}`);
    console.log(`agentApp：${config.agentApp}（At-Pet 显示为 GitHub Copilot）`);
    const client = new AtPetClient({ url: config.url, timeoutMs: config.timeoutMs });
    const health = await client.health();
    console.log(health.ok ? "At-Pet：可达" : `At-Pet：不可达（${health.error || health.status}）`);
    const appDir = path.join(args.repo, ".github", "extensions", args.name);
    console.log(`App 扩展：${existsSync(appDir) ? appDir : "未安装（node scripts/install.mjs app）"}`);
    const hooksFile = path.join(args.repo, ".github", "hooks", "atpet.json");
    console.log(`仓库 hooks：${existsSync(hooksFile) ? hooksFile : "未安装（node scripts/install.mjs cli）"}`);
    if (!health.ok) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "app") installApp(args);
else if (args.command === "cli") installCli(args);
else if (args.command === "doctor") await doctor(args);
else {
    console.error("用法：node scripts/install.mjs <app|cli|doctor> [--repo <dir>] [--dir <dir>] [--name <id>] [--no-hooks]");
    process.exitCode = 2;
}
