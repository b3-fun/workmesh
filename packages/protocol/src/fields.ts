// Field shapes shared by the ingest schemas (index.ts) and v1 Coordinate (coord.ts). Kept apart so coord.ts can use
// them without importing index.ts, which re-exports coord.ts.

export const HUB_ISSUE_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
export const HUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
