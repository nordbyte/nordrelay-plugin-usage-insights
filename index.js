#!/usr/bin/env node
import { runPlugin } from "./src/runtime.js";

runPlugin().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, stderr: message })}\n`);
  process.exitCode = 1;
});
