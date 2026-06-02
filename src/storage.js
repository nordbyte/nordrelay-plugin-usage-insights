import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

export const DB_FILE = "usage-insights.sqlite";
export const SCHEMA_VERSION = 1;

let DatabaseSyncClass;

export async function openUsageDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const Database = await loadDatabase();
  const dbPath = path.join(dataDir, DB_FILE);
  const db = new Database(dbPath);
  db.pragma?.("journal_mode = WAL");
  db.pragma?.("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_sessions (
      node_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      node_name TEXT,
      platform TEXT,
      agent_label TEXT,
      provider TEXT,
      model TEXT,
      session_name TEXT,
      workspace TEXT,
      session_path TEXT,
      source TEXT,
      confidence TEXT,
      created_at TEXT,
      updated_at TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      reported_cost_usd REAL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (node_id, agent_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS usage_deltas (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      session_name TEXT,
      workspace TEXT,
      source TEXT,
      confidence TEXT,
      occurred_at TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      reported_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_deltas_occurred ON usage_deltas (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_deltas_node ON usage_deltas (node_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_deltas_provider ON usage_deltas (provider, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_deltas_session ON usage_deltas (agent_id, thread_id, occurred_at);
    CREATE TABLE IF NOT EXISTS price_rules (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_per_1m REAL,
      cached_input_per_1m REAL,
      cache_write_per_1m REAL,
      output_per_1m REAL,
      reasoning_output_per_1m REAL,
      source TEXT NOT NULL DEFAULT 'custom',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, model, source)
    );
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export async function storageHealth(db, dataDir) {
  const dbPath = path.join(dataDir, DB_FILE);
  const stats = await stat(dbPath).catch(() => null);
  const sessionCount = scalar(db, "SELECT COUNT(*) FROM usage_sessions");
  const deltaCount = scalar(db, "SELECT COUNT(*) FROM usage_deltas");
  const priceRuleCount = scalar(db, "SELECT COUNT(*) FROM price_rules");
  return {
    dbPath,
    exists: Boolean(stats),
    sizeBytes: stats?.size ?? 0,
    sessionCount,
    deltaCount,
    priceRuleCount,
  };
}

export function collectUsageSnapshot(db, snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const collectedAt = new Date().toISOString();
  let insertedDeltas = 0;
  let updatedSessions = 0;
  for (const raw of sessions) {
    const session = normalizeUsageSession(snapshot, raw);
    if (!session || session.usage.totalTokens <= 0) continue;
    const previous = db.prepare(`
      SELECT input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_output_tokens, total_tokens, reported_cost_usd
      FROM usage_sessions WHERE node_id = ? AND agent_id = ? AND thread_id = ?
    `).get(session.nodeId, session.agentId, session.threadId);
    const delta = deltaUsage(previous, session.usage);
    const reportedCostDelta = costDelta(previous?.reported_cost_usd, session.costUsd);
    upsertSession(db, session, collectedAt);
    updatedSessions += 1;
    if (delta.totalTokens > 0 || reportedCostDelta > 0) {
      insertDelta(db, session, delta, reportedCostDelta, collectedAt);
      insertedDeltas += 1;
    }
  }
  return { collectedAt, sessions: updatedSessions, insertedDeltas };
}

export function readPanelData(db, input = {}) {
  const range = normalizeRange(input.range || "7d");
  const since = new Date(Date.now() - range.ms).toISOString();
  const rows = db.prepare("SELECT * FROM usage_deltas WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT 5000").all(since);
  const sessions = db.prepare("SELECT * FROM usage_sessions ORDER BY updated_at DESC LIMIT 500").all();
  const priceRules = db.prepare("SELECT * FROM price_rules ORDER BY provider, model, source").all();
  const pricedRows = rows.map((row) => ({ ...row, estimated_cost_usd: estimateCostForRow(row, priceRules) }));
  return {
    generatedAt: new Date().toISOString(),
    range,
    totals: summarizeRows(pricedRows),
    byNode: groupRows(pricedRows, "node_id"),
    byProvider: groupRows(pricedRows, "provider"),
    byModel: groupRows(pricedRows, "model"),
    byDay: groupRows(pricedRows, (row) => String(row.occurred_at).slice(0, 10)),
    sessions: sessions.map((row) => ({ ...row, estimated_cost_usd: estimateCostForRow(row, priceRules) })),
    priceCatalog: priceCatalogSummary(db, priceRules),
    storage: {
      deltaRows: rows.length,
      sessionRows: sessions.length,
      priceRules: priceRules.length,
    },
  };
}

export function readPriceRules(db) {
  return db.prepare("SELECT * FROM price_rules ORDER BY provider, model, source").all();
}

export function upsertPriceRule(db, rule) {
  db.prepare(`
    INSERT OR REPLACE INTO price_rules (
      provider, model, input_per_1m, cached_input_per_1m, cache_write_per_1m,
      output_per_1m, reasoning_output_per_1m, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.provider,
    rule.model,
    nullableNumber(rule.inputPer1M),
    nullableNumber(rule.cachedInputPer1M),
    nullableNumber(rule.cacheWritePer1M),
    nullableNumber(rule.outputPer1M),
    nullableNumber(rule.reasoningOutputPer1M),
    rule.source || "custom",
    rule.updatedAt || new Date().toISOString(),
  );
}

export function cleanupOldDeltas(db, retentionDays) {
  const days = Math.max(1, Number(retentionDays) || 365);
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM usage_deltas WHERE occurred_at < ?").run(before);
  return { before, deleted: result.changes || 0 };
}

export function exportUsage(db, input = {}) {
  const format = String(input.format || "json").toLowerCase();
  const range = normalizeRange(input.range || "30d");
  const since = new Date(Date.now() - range.ms).toISOString();
  const rows = db.prepare("SELECT * FROM usage_deltas WHERE occurred_at >= ? ORDER BY occurred_at ASC").all(since);
  if (format === "csv") {
    const columns = ["occurred_at", "node_id", "agent_id", "thread_id", "provider", "model", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "reported_cost_usd"];
    const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n");
    return { format: "csv", range, text: csv };
  }
  return { format: "json", range, rows };
}

export function readState(db, key) {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function writeState(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), new Date().toISOString());
}

function upsertSession(db, session, collectedAt) {
  db.prepare(`
    INSERT INTO usage_sessions (
      node_id, agent_id, thread_id, node_name, platform, agent_label, provider, model, session_name,
      workspace, session_path, source, confidence, created_at, updated_at, input_tokens,
      cached_input_tokens, cache_write_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      reported_cost_usd, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id, agent_id, thread_id) DO UPDATE SET
      node_name = excluded.node_name,
      platform = excluded.platform,
      agent_label = excluded.agent_label,
      provider = excluded.provider,
      model = excluded.model,
      session_name = excluded.session_name,
      workspace = excluded.workspace,
      session_path = excluded.session_path,
      source = excluded.source,
      confidence = excluded.confidence,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      reported_cost_usd = excluded.reported_cost_usd,
      last_seen_at = excluded.last_seen_at
  `).run(
    session.nodeId,
    session.agentId,
    session.threadId,
    session.nodeName,
    session.platform,
    session.agentLabel,
    session.provider,
    session.model,
    session.sessionName,
    session.workspace,
    session.sessionPath,
    session.source,
    session.confidence,
    session.createdAt,
    session.updatedAt,
    session.usage.inputTokens,
    session.usage.cachedInputTokens,
    session.usage.cacheWriteTokens,
    session.usage.outputTokens,
    session.usage.reasoningOutputTokens,
    session.usage.totalTokens,
    nullableNumber(session.costUsd),
    collectedAt,
    collectedAt,
  );
}

function insertDelta(db, session, delta, reportedCostDelta, collectedAt) {
  const id = createDeltaId(session, delta, reportedCostDelta);
  db.prepare(`
    INSERT OR IGNORE INTO usage_deltas (
      id, node_id, agent_id, thread_id, provider, model, session_name, workspace, source, confidence,
      occurred_at, collected_at, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
      reasoning_output_tokens, total_tokens, reported_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    session.nodeId,
    session.agentId,
    session.threadId,
    session.provider,
    session.model,
    session.sessionName,
    session.workspace,
    session.source,
    session.confidence,
    session.updatedAt,
    collectedAt,
    delta.inputTokens,
    delta.cachedInputTokens,
    delta.cacheWriteTokens,
    delta.outputTokens,
    delta.reasoningOutputTokens,
    delta.totalTokens,
    reportedCostDelta || null,
  );
}

function deltaUsage(previous, usage) {
  const previousUsage = {
    inputTokens: Number(previous?.input_tokens) || 0,
    cachedInputTokens: Number(previous?.cached_input_tokens) || 0,
    cacheWriteTokens: Number(previous?.cache_write_tokens) || 0,
    outputTokens: Number(previous?.output_tokens) || 0,
    reasoningOutputTokens: Number(previous?.reasoning_output_tokens) || 0,
    totalTokens: Number(previous?.total_tokens) || 0,
  };
  const delta = {
    inputTokens: Math.max(0, usage.inputTokens - previousUsage.inputTokens),
    cachedInputTokens: Math.max(0, usage.cachedInputTokens - previousUsage.cachedInputTokens),
    cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - previousUsage.cacheWriteTokens),
    outputTokens: Math.max(0, usage.outputTokens - previousUsage.outputTokens),
    reasoningOutputTokens: Math.max(0, usage.reasoningOutputTokens - previousUsage.reasoningOutputTokens),
    totalTokens: Math.max(0, usage.totalTokens - previousUsage.totalTokens),
  };
  const recomputed = delta.inputTokens + delta.cachedInputTokens + delta.cacheWriteTokens + delta.outputTokens + delta.reasoningOutputTokens;
  if (recomputed > delta.totalTokens) delta.totalTokens = recomputed;
  return delta;
}

function costDelta(previousCost, nextCost) {
  const previous = Number(previousCost) || 0;
  const next = Number(nextCost) || 0;
  return Math.max(0, next - previous);
}

function createDeltaId(session, delta, reportedCostDelta) {
  return createHash("sha256").update(JSON.stringify({
    nodeId: session.nodeId,
    agentId: session.agentId,
    threadId: session.threadId,
    updatedAt: session.updatedAt,
    delta,
    reportedCostDelta,
  })).digest("hex").slice(0, 32);
}

function normalizeUsageSession(snapshot, raw) {
  const usage = normalizeUsage(raw?.usage);
  const threadId = String(raw?.threadId || "").trim();
  const agentId = String(raw?.agentId || "").trim();
  if (!threadId || !agentId || !usage) return null;
  const node = snapshot?.node || {};
  return {
    nodeId: String(raw.nodeId || node.id || "local"),
    nodeName: String(raw.nodeName || node.name || "Local node"),
    platform: String(raw.platform || node.platform || ""),
    agentId,
    agentLabel: String(raw.agentLabel || agentId),
    provider: String(raw.provider || providerFromModel(raw.model) || agentId),
    model: raw.model ? String(raw.model) : null,
    threadId,
    sessionName: raw.sessionName ? String(raw.sessionName) : "",
    workspace: String(raw.workspace || ""),
    sessionPath: raw.sessionPath ? String(raw.sessionPath) : "",
    source: String(raw.source || "unknown"),
    confidence: String(raw.confidence || "reported"),
    createdAt: validIso(raw.createdAt) || validIso(raw.updatedAt) || new Date().toISOString(),
    updatedAt: validIso(raw.updatedAt) || new Date().toISOString(),
    usage,
    costUsd: nullableNumber(raw.costUsd),
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const usage = {
    inputTokens: nonNegative(raw.inputTokens),
    cachedInputTokens: nonNegative(raw.cachedInputTokens),
    cacheWriteTokens: nonNegative(raw.cacheWriteTokens),
    outputTokens: nonNegative(raw.outputTokens),
    reasoningOutputTokens: nonNegative(raw.reasoningOutputTokens),
    totalTokens: nonNegative(raw.totalTokens),
  };
  const recomputed = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens + usage.reasoningOutputTokens;
  if (recomputed > usage.totalTokens) usage.totalTokens = recomputed;
  return usage.totalTokens > 0 ? usage : null;
}

function summarizeRows(rows) {
  const total = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    reportedCostUsd: 0,
    unknownCostRows: 0,
    rows: 0,
  };
  for (const row of rows) {
    total.rows += 1;
    total.inputTokens += Number(row.input_tokens) || 0;
    total.cachedInputTokens += Number(row.cached_input_tokens) || 0;
    total.cacheWriteTokens += Number(row.cache_write_tokens) || 0;
    total.outputTokens += Number(row.output_tokens) || 0;
    total.reasoningOutputTokens += Number(row.reasoning_output_tokens) || 0;
    total.totalTokens += Number(row.total_tokens) || 0;
    if (row.estimated_cost_usd !== null && row.estimated_cost_usd !== undefined && Number.isFinite(Number(row.estimated_cost_usd))) total.estimatedCostUsd += Number(row.estimated_cost_usd);
    else total.unknownCostRows += 1;
    total.reportedCostUsd += Number(row.reported_cost_usd) || 0;
  }
  return total;
}

function groupRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = typeof key === "function" ? key(row) : row[key];
    const id = String(value || "unknown");
    const group = groups.get(id) || { id, label: id, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => ({ id: group.id, label: group.label, ...summarizeRows(group.rows) }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens);
}

function estimateCostForRow(row, priceRules) {
  const rule = findPriceRule(priceRules, row.provider, row.model);
  if (!rule) return row.reported_cost_usd !== null && row.reported_cost_usd !== undefined && Number.isFinite(Number(row.reported_cost_usd))
    ? Number(row.reported_cost_usd)
    : null;
  return (
    ((Number(row.input_tokens) || 0) * nullableNumber(rule.input_per_1m) +
      (Number(row.cached_input_tokens) || 0) * nullableNumber(rule.cached_input_per_1m) +
      (Number(row.cache_write_tokens) || 0) * nullableNumber(rule.cache_write_per_1m) +
      (Number(row.output_tokens) || 0) * nullableNumber(rule.output_per_1m) +
      (Number(row.reasoning_output_tokens) || 0) * nullableNumber(rule.reasoning_output_per_1m)) / 1_000_000
  );
}

function findPriceRule(rules, provider, model) {
  const normalizedModel = String(model || "").trim();
  const normalizedProvider = String(provider || "").trim();
  const candidates = [
    normalizedModel,
    normalizedModel.includes("/") ? normalizedModel.split("/").slice(1).join("/") : "",
    `${normalizedProvider}/${normalizedModel}`,
  ].filter(Boolean);
  return rules.find((rule) => candidates.includes(String(rule.model))) ||
    rules.find((rule) => String(rule.provider) === normalizedProvider && String(rule.model) === "*");
}

function priceCatalogSummary(db, rules) {
  const state = readState(db, "price_catalog") || {};
  return {
    rules: rules.length,
    source: state.source || "",
    fetchedAt: state.fetchedAt || "",
    error: state.error || "",
  };
}

function normalizeRange(value) {
  const text = String(value || "7d").trim().toLowerCase();
  const match = /^(\\d+)(m|h|d|w)$/i.exec(text);
  if (!match) return { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 };
  const amount = Math.max(1, Number(match[1]) || 1);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "w" ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
  return { label: `${amount}${unit}`, ms: amount * multiplier };
}

function validIso(value) {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerFromModel(model) {
  const text = String(model || "");
  return text.includes("/") ? text.split("/")[0] : "";
}

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return Number(Object.values(row || {})[0]) || 0;
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function loadDatabase() {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  const imported = await import("better-sqlite3").catch((error) => {
    throw new Error(`better-sqlite3 is required for Usage Insights: ${error instanceof Error ? error.message : String(error)}`);
  });
  DatabaseSyncClass = imported.default || imported;
  return DatabaseSyncClass;
}
