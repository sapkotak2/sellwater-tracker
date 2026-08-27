#!/usr/bin/env node
// Runs the collector forever on an interval. Used by the Docker image and by
// anyone who just wants to leave a terminal open.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINUTES = Number(process.env.INTERVAL_MINUTES || 5);

function run(script) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "src", script)], { stdio: "inherit" });
    p.on("close", (code) => resolve(code));
  });
}

async function cycle() {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${stamp} UTC]`);
  await run("collect.mjs");
  await run("build.mjs");
}

console.log(`tracker loop started, every ${MINUTES} minute(s). Ctrl-C to stop.`);
await cycle();
setInterval(cycle, MINUTES * 60000);
