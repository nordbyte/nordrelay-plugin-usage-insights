import {
  attr,
  badge,
  escapeHtml,
  formatAge,
  formatCompactNumber,
  formatPercent,
  formatUsd,
  metric,
  shortText,
  tokenCells,
} from "./format.js";

const RANGES = ["24h", "7d", "30d", "90d", "365d"];

export function renderDashboardPanel(input = {}, context = {}, settings = {}) {
  const aggregate = input.aggregate && typeof input.aggregate === "object" ? input.aggregate : {};
  const results = Array.isArray(aggregate.results) ? aggregate.results : [];
  const pending = Array.isArray(aggregate.pending) ? aggregate.pending : [];
  const nodes = normalizeAggregateResults(results, context);
  const range = normalizeRange(input.range || aggregate.input?.range || "7d");
  const totals = summarizeNodes(nodes);
  const byNode = mergeGroups(nodes, "byNode");
  const byProvider = mergeGroups(nodes, "byProvider");
  const byModel = mergeGroups(nodes, "byModel");
  const byDay = mergeGroups(nodes, "byDay").sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sessions = mergeSessions(nodes);
  return `<style>
    .usage-chart{min-height:160px;display:flex;align-items:flex-end;gap:8px;overflow-x:auto;padding:14px 4px 2px}
    .usage-chart-bar{min-width:28px;background:linear-gradient(180deg,#28b36f,#167548);border-radius:4px 4px 0 0;position:relative}
    .usage-chart-bar span{position:absolute;left:50%;bottom:-22px;transform:translateX(-50%);font-size:12px;white-space:nowrap;color:var(--muted)}
  </style><div class="stack" data-usage-insights data-range="${attr(range)}">
    <div class="section-header">
      <div>
        <h1>Usage Insights <small>- ${escapeHtml(nodes.length)} node${nodes.length === 1 ? "" : "s"}</small></h1>
        <small>Estimated token costs grouped by node, provider, model, session, and time range.${pending.length ? ` ${escapeHtml(pending.length)} pending.` : ""}</small>
      </div>
      <div class="row">
        ${RANGES.map((item) => `<button type="button" class="secondary mini-button ${item === range ? "active" : ""}" data-usage-range="${attr(item)}">${escapeHtml(item)}</button>`).join("")}
        <button type="button" class="secondary mini-button" data-refresh-prices>Refresh prices</button>
      </div>
    </div>
    <div class="metric-grid">
      ${metric("Estimated cost", formatUsd(totals.estimatedCostUsd), totals.unknownCostRows ? `${totals.unknownCostRows} rows need rates` : "all known priced")}
      ${metric("Total tokens", formatCompactNumber(totals.totalTokens), `${formatCompactNumber(totals.rows)} usage rows`)}
      ${metric("Input / cached", `${formatCompactNumber(totals.inputTokens)} / ${formatCompactNumber(totals.cachedInputTokens)}`, "cached is priced separately")}
      ${metric("Output / reasoning", `${formatCompactNumber(totals.outputTokens)} / ${formatCompactNumber(totals.reasoningOutputTokens)}`, "estimated by model rule")}
    </div>
    ${renderChart(byDay)}
    <div class="tabs" data-usage-tabs>
      <button type="button" class="tab active" data-usage-tab="nodes">Nodes</button>
      <button type="button" class="tab" data-usage-tab="providers">Providers</button>
      <button type="button" class="tab" data-usage-tab="models">Models</button>
      <button type="button" class="tab" data-usage-tab="sessions">Sessions</button>
      <button type="button" class="tab" data-usage-tab="prices">Price catalog</button>
    </div>
    <section class="panel" data-usage-tab-panel="nodes">${renderGroupTable("Node", byNode)}</section>
    <section class="panel" data-usage-tab-panel="providers" hidden>${renderGroupTable("Provider", byProvider)}</section>
    <section class="panel" data-usage-tab-panel="models" hidden>${renderGroupTable("Model", byModel)}</section>
    <section class="panel" data-usage-tab-panel="sessions" hidden>${renderSessionTable(sessions)}</section>
    <section class="panel" data-usage-tab-panel="prices" hidden>${renderPriceCatalog(nodes, settings)}</section>
  </div>`;
}

export function dashboardPanelScript() {
  return `
    const root = api.root.querySelector('[data-usage-insights]');
    if (!root) return;
    root.querySelectorAll('[data-usage-range]').forEach((button) => {
      api.addEventListener(button, 'click', () => api.reload({ range: button.dataset.usageRange || '7d' }));
    });
    root.querySelectorAll('[data-usage-tab]').forEach((button) => {
      api.addEventListener(button, 'click', () => {
        const tab = button.dataset.usageTab || 'nodes';
        root.querySelectorAll('[data-usage-tab]').forEach((item) => item.classList.toggle('active', item === button));
        root.querySelectorAll('[data-usage-tab-panel]').forEach((panel) => { panel.hidden = panel.dataset.usageTabPanel !== tab; });
      });
    });
    const refreshPrices = root.querySelector('[data-refresh-prices]');
    if (refreshPrices) {
      api.addEventListener(refreshPrices, 'click', async () => {
        refreshPrices.disabled = true;
        try {
          await api.invokeCommand('refresh-prices', {}, { timeoutMs: 120000 });
          api.toast('Price catalog refreshed');
          await api.reload({ range: root.dataset.range || '7d' });
        } catch (error) {
          api.toast(error && error.message ? error.message : String(error), { duration: 5000 });
        } finally {
          refreshPrices.disabled = false;
        }
      });
    }
  `;
}

function normalizeAggregateResults(results, context) {
  const normalized = [];
  for (const item of results) {
    const panelData = item?.result?.output?.panelData || item?.result?.panelData || item?.output?.panelData;
    if (!panelData) continue;
    normalized.push({
      node: {
        id: item?.node?.id || panelData.nodeId || "local",
        name: item?.node?.name || panelData.nodeName || context?.runtime?.nodeName || "Local node",
        platform: item?.node?.platform || "",
      },
      panelData,
    });
  }
  if (!normalized.length && context?.usage) {
    normalized.push({
      node: {
        id: context.usage.node?.id || "local",
        name: context.usage.node?.name || "Local node",
        platform: context.usage.node?.platform || "",
      },
      panelData: {
        totals: summarizeUsageSessions(context.usage.sessions || []),
        byNode: [],
        byProvider: [],
        byModel: [],
        byDay: [],
        sessions: context.usage.sessions || [],
        priceCatalog: { rules: 0 },
      },
    });
  }
  return normalized.sort((a, b) => String(a.node.name).localeCompare(String(b.node.name)));
}

function renderChart(rows) {
  const data = rows.slice(-30);
  const max = Math.max(1, ...data.map((row) => Number(row.estimatedCostUsd) || 0));
  const bars = data.map((row) => {
    const height = Math.max(4, ((Number(row.estimatedCostUsd) || 0) / max) * 120);
    return `<div class="usage-chart-bar" title="${attr(row.label)}: ${attr(formatUsd(row.estimatedCostUsd))}" style="height:${height.toFixed(1)}px"><span>${escapeHtml(shortText(row.label, 8))}</span></div>`;
  }).join("");
  return `<section class="panel">
    <div class="section-header"><h2>Cost trend</h2><small>Estimated cost by day for the selected range.</small></div>
    <div class="usage-chart">${bars || '<div class="empty-state">No usage deltas for this range.</div>'}</div>
  </section>`;
}

function renderGroupTable(label, rows) {
  return `<div class="section-header"><h2>${escapeHtml(label)}</h2><small>${escapeHtml(rows.length)} group${rows.length === 1 ? "" : "s"}</small></div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>${escapeHtml(label)}</th><th>Cost</th><th>Input</th><th>Cached</th><th>Cache write</th><th>Output</th><th>Reasoning</th><th>Total</th></tr></thead>
        <tbody>${rows.map((row) => {
          const tokens = tokenCells(row);
          return `<tr><td class="primary-cell" title="${attr(row.label)}">${escapeHtml(shortText(row.label || row.id, 80))}</td><td>${escapeHtml(formatUsd(row.estimatedCostUsd))}</td><td>${tokens[0]}</td><td>${tokens[1]}</td><td>${tokens[2]}</td><td>${tokens[3]}</td><td>${tokens[4]}</td><td>${tokens[5]}</td></tr>`;
        }).join("") || `<tr><td colspan="8">No usage data for this range.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderSessionTable(rows) {
  return `<div class="section-header"><h2>Sessions</h2><small>${escapeHtml(rows.length)} sessions</small></div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Updated</th><th>Session</th><th>Node</th><th>Agent</th><th>Provider</th><th>Model</th><th>Workspace</th><th>Cost</th><th>Total</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td title="${attr(row.updated_at || row.updatedAt)}">${escapeHtml(formatAge(row.updated_at || row.updatedAt))}</td>
          <td class="primary-cell" title="${attr(row.thread_id || row.threadId)}">${escapeHtml(shortText(row.session_name || row.sessionName || row.thread_id || row.threadId, 70))}</td>
          <td>${escapeHtml(shortText(row.node_name || row.nodeName || row.node_id || row.nodeId, 50))}</td>
          <td>${escapeHtml(row.agent_id || row.agentId || "")}</td>
          <td>${escapeHtml(row.provider || "")}</td>
          <td title="${attr(row.model || "")}">${escapeHtml(shortText(row.model || "-", 70))}</td>
          <td title="${attr(row.workspace || "")}">${escapeHtml(shortText(row.workspace || "-", 80))}</td>
          <td>${escapeHtml(formatUsd(row.estimated_cost_usd ?? row.costUsd))}</td>
          <td>${escapeHtml(formatCompactNumber(row.total_tokens ?? row.usage?.totalTokens))}</td>
        </tr>`).join("") || `<tr><td colspan="9">No sessions with usage data.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderPriceCatalog(nodes, settings) {
  const summaries = nodes.map((node) => node.panelData?.priceCatalog).filter(Boolean);
  const totalRules = summaries.reduce((sum, item) => sum + (Number(item.rules) || 0), 0);
  const latestFetch = summaries.map((item) => item.fetchedAt).filter(Boolean).sort().at(-1) || "";
  const errors = summaries.map((item) => item.error).filter(Boolean);
  return `<div class="section-header"><h2>Price catalog</h2><small>Costs are estimates and cached/input/output are priced separately where rates are known.</small></div>
    <div class="metric-grid">
      ${metric("Price rules", formatCompactNumber(totalRules), "fetched + custom")}
      ${metric("Latest fetch", latestFetch ? formatAge(latestFetch) : "never", settings.priceCatalogUrl || "")}
      ${metric("Unknown cost rows", formatCompactNumber(summarizeNodes(nodes).unknownCostRows), "add model rates if needed")}
    </div>
    ${errors.length ? `<div class="callout warn">${escapeHtml(errors.join(" · "))}</div>` : `<div class="callout">Remote prices use the LiteLLM model price catalog by default.</div>`}`;
}

function summarizeNodes(nodes) {
  return nodes.reduce((total, node) => addTotals(total, node.panelData?.totals || {}), emptyTotals());
}

function mergeGroups(nodes, key) {
  const groups = new Map();
  for (const node of nodes) {
    for (const row of node.panelData?.[key] || []) {
      const id = String(row.id || row.label || "unknown");
      const existing = groups.get(id) || { ...emptyTotals(), id, label: row.label || id };
      groups.set(id, addTotals(existing, row));
    }
  }
  return [...groups.values()].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens);
}

function mergeSessions(nodes) {
  return nodes.flatMap((node) => (node.panelData?.sessions || []).map((session) => ({
    ...session,
    node_name: session.node_name || node.node.name,
    node_id: session.node_id || node.node.id,
  }))).sort((a, b) => Date.parse(b.updated_at || b.updatedAt || 0) - Date.parse(a.updated_at || a.updatedAt || 0));
}

function summarizeUsageSessions(sessions) {
  return sessions.reduce((total, session) => addTotals(total, {
    inputTokens: session.usage?.inputTokens || 0,
    cachedInputTokens: session.usage?.cachedInputTokens || 0,
    cacheWriteTokens: session.usage?.cacheWriteTokens || 0,
    outputTokens: session.usage?.outputTokens || 0,
    reasoningOutputTokens: session.usage?.reasoningOutputTokens || 0,
    totalTokens: session.usage?.totalTokens || 0,
    estimatedCostUsd: session.costUsd || 0,
    rows: 1,
  }), emptyTotals());
}

function addTotals(total, row) {
  total.inputTokens += Number(row.inputTokens ?? row.input_tokens) || 0;
  total.cachedInputTokens += Number(row.cachedInputTokens ?? row.cached_input_tokens) || 0;
  total.cacheWriteTokens += Number(row.cacheWriteTokens ?? row.cache_write_tokens) || 0;
  total.outputTokens += Number(row.outputTokens ?? row.output_tokens) || 0;
  total.reasoningOutputTokens += Number(row.reasoningOutputTokens ?? row.reasoning_output_tokens) || 0;
  total.totalTokens += Number(row.totalTokens ?? row.total_tokens) || 0;
  total.estimatedCostUsd += Number(row.estimatedCostUsd ?? row.estimated_cost_usd) || 0;
  total.reportedCostUsd += Number(row.reportedCostUsd ?? row.reported_cost_usd) || 0;
  total.unknownCostRows += Number(row.unknownCostRows) || 0;
  total.rows += Number(row.rows) || 0;
  return total;
}

function emptyTotals() {
  return {
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
}

function normalizeRange(value) {
  const text = String(value || "7d").trim().toLowerCase();
  return RANGES.includes(text) ? text : "7d";
}
