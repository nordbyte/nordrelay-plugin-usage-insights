export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function attr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

export function formatCompactNumber(value, fractionDigits = 1) {
  const number = Number(value) || 0;
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${trimNumber(number / 1_000_000_000, fractionDigits)}B`;
  if (abs >= 1_000_000) return `${trimNumber(number / 1_000_000, fractionDigits)}M`;
  if (abs >= 1_000) return `${trimNumber(number / 1_000, fractionDigits)}K`;
  return String(Math.round(number));
}

export function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (Math.abs(number) < 0.01) return `$${number.toFixed(4)}`;
  if (Math.abs(number) < 100) return `$${number.toFixed(2)}`;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1).replace(/\\.0$/, "")}%` : "-";
}

export function formatAge(value) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function badge(label, variant = "enabled") {
  return `<span class="adapter-status ${escapeHtml(variant)}">${escapeHtml(label)}</span>`;
}

export function metric(label, value, detail = "") {
  return `<div class="metric-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div>`;
}

export function tokenCells(usage) {
  return [
    formatCompactNumber(usage.inputTokens),
    formatCompactNumber(usage.cachedInputTokens),
    formatCompactNumber(usage.cacheWriteTokens),
    formatCompactNumber(usage.outputTokens),
    formatCompactNumber(usage.reasoningOutputTokens),
    formatCompactNumber(usage.totalTokens),
  ];
}

export function trimNumber(value, fractionDigits = 1) {
  return Number(value).toFixed(fractionDigits).replace(/\\.0+$/, "").replace(/(\\.\\d*[1-9])0+$/, "$1");
}

export function shortText(value, max = 80) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
