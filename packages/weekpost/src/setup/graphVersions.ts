// Graph API versions and the date each one stops being available, from the Meta changelog
// (https://developers.facebook.com/docs/graph-api/changelog/, read on 2026-10-30; the page calls the column
// "Available Until"). `doctor` compares the version the publisher pins with this table. Refresh it when Meta
// ships a version: an unknown version is reported as a warning, never silently accepted.
export const GRAPH_VERSIONS: Record<string, { introduced: string; availableUntil: string | null }> = {
  "v19.0": { introduced: "2024-01-23", availableUntil: "2026-05-21" },
  "v20.0": { introduced: "2024-05-21", availableUntil: "2026-09-24" },
  "v21.0": { introduced: "2024-10-02", availableUntil: "2027-01-21" },
  "v22.0": { introduced: "2025-01-21", availableUntil: "2027-05-20" },
  "v23.0": { introduced: "2025-05-29", availableUntil: "2027-10-08" },
  "v24.0": { introduced: "2025-10-08", availableUntil: "2028-02-18" },
  "v25.0": { introduced: "2026-02-18", availableUntil: "2028-07-29" },
  // The latest version has no end date yet ("TBD" in the changelog).
  "v26.0": { introduced: "2026-07-29", availableUntil: null },
};

export type VersionStatus = { level: "ok" | "warn" | "fail"; detail: string };

/** How close a version is to the end of its availability. Warns in the last 180 days. */
export function graphVersionStatus(version: string, now: Date, table = GRAPH_VERSIONS): VersionStatus {
  const v = table[version];
  if (!v) return { level: "warn", detail: `${version} is not in the table that ships with weekpost; check https://developers.facebook.com/docs/graph-api/changelog/` };
  if (!v.availableUntil) return { level: "ok", detail: `${version} is the latest version (no end date yet)` };
  const days = Math.floor((Date.parse(`${v.availableUntil}T00:00:00Z`) - now.getTime()) / 86_400_000);
  if (days < 0) return { level: "fail", detail: `${version} stopped being available on ${v.availableUntil}` };
  if (days <= 180) return { level: "warn", detail: `${version} stops being available on ${v.availableUntil} (${days} days)` };
  return { level: "ok", detail: `${version} is available until ${v.availableUntil}` };
}
