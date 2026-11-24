// The original's small text helpers the X3 families read, in one file (src/ds is flat):
// formatAddress and capitalizeWords from b3-mono apps/b3os-web/lib/utils.ts, camelToWords and formatLabel from
// utils/string.ts, isSolanaAddress from lib/utils/address.ts, isChainIdKey from
// components/ui/workflow-step-row/components/InlineAddressLink.tsx @ f50f3ba3b97e. They shorten and label values; the
// crypto lookups around them (chains, explorers, token metadata) are not ported (EXTRACT rule 1).

/** A long id or hash shortened in the middle: 0x1234...abcd. */
export function formatAddress(address: string, start = 6, end = 4): string {
  if (!address || address.length < 10) {
    return address;
  }
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

export function capitalizeWords(str: string): string {
  return str
    .split(/[-\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export const camelToWords = (key: string): string => {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, "$1 $2")
    .trim();
};

/** A camelCase or snake_case key as a Title Case label: "myLabelSelector" is "My Label Selector". */
export const formatLabel = (key: string): string => {
  return camelToWords(key)
    .replace(/_/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const SOLANA_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isSolanaAddress(value: string): boolean {
  return SOLANA_BASE58_REGEX.test(value);
}

export function isChainIdKey(key: string): boolean {
  const normalized = key.replace(/[_\s-]/g, "").toLowerCase();
  return normalized.endsWith("chainid") || normalized === "srcchain" || normalized === "dstchain";
}

// typeToDisplayName and formatConnectorName from utils/string.ts; getRequiredConnectorType and its table from
// utils/workflowTransform.ts (the rest of that file transforms the old API's graphs: not ported).
export const typeToDisplayName = (type: string): string => {
  // Strip common provider prefixes
  const stripped = type
    .replace(/^(coingecko|alchemy|moralis|chainlink|uniswap|aave|compound|slack|discord|telegram)-/, "")
    .replace(/^(send|get|check|fetch|trigger|create|update|delete)-?/, "$1 ");

  return stripped
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

export const formatConnectorName = (connectorType: string): string => {
  return connectorType
    .replace(/^pipedream:/i, "")
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const NODE_TYPE_CONNECTOR_REQUIREMENTS: Record<string, string> = {
  "call-x402-endpoint": "wallet",
};

export function getRequiredConnectorType(
  nodeType: string | undefined,
  definition: { connector?: { type: string } } | undefined,
): string | undefined {
  // First check the definition
  if (definition?.connector?.type) {
    return definition.connector.type;
  }

  // Fall back to known node type requirements
  if (nodeType && NODE_TYPE_CONNECTOR_REQUIREMENTS[nodeType]) {
    return NODE_TYPE_CONNECTOR_REQUIREMENTS[nodeType];
  }

  return undefined;
}

/** formatDuration from lib/utils.ts: "1.5s", "2.3m", "1.2h". */
export function formatDuration(ms?: number): string {
  if (!ms) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/** generateColorFromAddress and avatarColors from config/constants.ts: one of eight colours, the same for one id. */
export const avatarColors = ["#3368ef", "#272727", "#6366f1", "#06b6d4", "#eeb0d9", "#ba3fbf", "#ff777b", "#dfbb53"];
export function generateColorFromAddress(address: string): string {
  const colors = avatarColors;
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = ((hash << 5) - hash + address.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length] ?? colors[0] ?? "#3368ef";
}

/** formatRelativeTime from lib/utils.ts: "just now", "5 minutes ago", "3 days ago". */
export function formatRelativeTime(date: Date, nowMs: number = Date.now()): string {
  const diffInSeconds = Math.floor((nowMs - date.getTime()) / 1000);
  if (diffInSeconds < 60) return "just now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (diffInSeconds < 3600) return plural(Math.floor(diffInSeconds / 60), "minute");
  if (diffInSeconds < 86400) return plural(Math.floor(diffInSeconds / 3600), "hour");
  if (diffInSeconds < 2592000) return plural(Math.floor(diffInSeconds / 86400), "day");
  if (diffInSeconds < 31536000) return plural(Math.floor(diffInSeconds / 2592000), "month");
  return plural(Math.floor(diffInSeconds / 31536000), "year");
}

/** formatUsername from lib/utils.ts: "@name" without the old account suffix. */
export function formatUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const cleanUsername = username.replace(/\.b3\.fun$/, "");
  return cleanUsername.startsWith("@") ? cleanUsername : `@${cleanUsername}`;
}

/** getWorkflowRunDurationMs from lib/workflow/workflowRuns.ts. */
export function getWorkflowRunDurationMs({
  startedAt,
  finishedAt,
}: {
  startedAt?: string | null;
  finishedAt?: string | null;
}): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  return new Date(finishedAt).getTime() - new Date(startedAt).getTime();
}
