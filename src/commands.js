export const COMMANDS = new Set([
  "collect",
  "panel-data",
  "refresh-prices",
  "price-catalog",
  "export",
  "cleanup",
  "storage-health",
]);

export function normalizeCommand(request) {
  const value = String(request?.command || request?.capabilityId || request?.input?.command || "").trim();
  return COMMANDS.has(value) ? value : "panel-data";
}
