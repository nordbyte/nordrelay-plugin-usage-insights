import { normalizeCommand } from "./commands.js";
import {
  cleanupOldDeltas,
  collectUsageSnapshot,
  exportUsage,
  openUsageDatabase,
  readPanelData,
  readPriceRules,
  storageHealth,
} from "./storage.js";
import { maybeRefreshPriceCatalog, normalizeSettings, refreshPriceCatalog } from "./pricing.js";
import { dashboardPanelScript, renderDashboardPanel } from "./render-panel.js";

export async function runPlugin() {
  const request = await readRequest();
  const settings = normalizeSettings(request.settings);
  const dataDir = request.dataDir || process.cwd();

  if (request.type === "web-panel") {
    const html = renderDashboardPanel(request.input || {}, request.context || {}, settings);
    writeResult({ ok: true, html, panel: { script: dashboardPanelScript() } });
    return;
  }

  const db = await openUsageDatabase(dataDir);
  try {
    if (request.type === "diagnostics") {
      writeResult({ ok: true, diagnostics: { plugin: "usage-insights", storage: await storageHealth(db, dataDir), prices: readPriceRules(db).length } });
      return;
    }

    if (request.type === "collector") {
      requirePermission(request, "usage.read");
      const collected = collectUsageSnapshot(db, request.context?.usage);
      await maybeRefreshPriceCatalog(db, settings);
      writeResult({ ok: true, output: { collected } });
      return;
    }

    if (request.type === "command") {
      await handleCommand(request, db, dataDir, settings);
      return;
    }

    writeResult({ ok: false, stderr: `Unsupported request type: ${request.type}` });
  } finally {
    db.close?.();
  }
}

async function handleCommand(request, db, dataDir, settings) {
  const command = normalizeCommand(request);
  if (command === "collect") {
    requirePermission(request, "usage.read");
    const collected = collectUsageSnapshot(db, request.context?.usage);
    await maybeRefreshPriceCatalog(db, settings);
    writeResult({ ok: true, output: { collected } });
    return;
  }
  if (command === "panel-data") {
    requirePermission(request, "usage.read");
    const collected = collectUsageSnapshot(db, request.context?.usage);
    const priceRefresh = await maybeRefreshPriceCatalog(db, settings);
    const panelData = readPanelData(db, request.input || {});
    writeResult({ ok: true, output: { collected, priceRefresh, panelData } });
    return;
  }
  if (command === "refresh-prices") {
    requirePermission(request, "network");
    writeResult({ ok: true, output: { priceRefresh: await refreshPriceCatalog(db, settings, { force: true }) } });
    return;
  }
  if (command === "price-catalog") {
    writeResult({ ok: true, output: { rules: readPriceRules(db) } });
    return;
  }
  if (command === "export") {
    writeResult({ ok: true, output: exportUsage(db, request.input || {}) });
    return;
  }
  if (command === "cleanup") {
    writeResult({ ok: true, output: { cleanup: cleanupOldDeltas(db, settings.retentionDays) } });
    return;
  }
  if (command === "storage-health") {
    writeResult({ ok: true, output: { storage: await storageHealth(db, dataDir) } });
    return;
  }
  writeResult({ ok: false, stderr: `Unknown usage-insights command: ${command}` });
}

function requirePermission(request, permission) {
  if (!Array.isArray(request.permissions) || !request.permissions.includes(permission)) {
    throw new Error(`Permission required: ${permission}`);
  }
}

async function readRequest() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("No plugin request received.");
  return JSON.parse(raw);
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
