import { getVersion } from "@tauri-apps/api/app";

const REPO = "ok2cqr/shellboard";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "shellboard.updateCheck";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateInfo = {
  current: string;
  /** Release tag with the leading `v` stripped, e.g. "1.2.0". */
  latest: string;
  /** GitHub release page — `openUrl()` it to send the user there. */
  url: string;
  /** Markdown body of the release. May be empty. */
  notes: string;
};

type CacheEntry = {
  checkedAt: number;
  /** Cached so the badge survives a relaunch without an extra fetch. */
  info: UpdateInfo | null;
};

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* quota exceeded or storage disabled — non-fatal */
  }
}

/** Strip a leading `v`/`V` and split into numeric parts. Non-numeric
 * suffixes (rc, beta) are ignored on the contributing segment so e.g.
 * `1.2.0-rc.1` compares as `1.2.0`. Good enough for our use. */
function parseVersion(v: string): number[] {
  const cleaned = v.replace(/^[vV]/, "").split("-")[0];
  return cleaned.split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** > 0 if a > b, < 0 if a < b, 0 equal. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

type GithubReleaseResponse = {
  tag_name: string;
  html_url: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
};

/**
 * Returns update info if a newer release is available, null otherwise.
 * Hits the GitHub API at most once per CACHE_TTL_MS regardless of how
 * many times the app starts. Pass `force: true` to bypass the cache
 * (e.g. from a "Check now" button).
 */
export async function checkForUpdate(
  options: { force?: boolean } = {},
): Promise<UpdateInfo | null> {
  const cache = readCache();
  if (
    !options.force &&
    cache &&
    Date.now() - cache.checkedAt < CACHE_TTL_MS
  ) {
    return cache.info;
  }

  let current: string;
  try {
    current = await getVersion();
  } catch {
    return null;
  }

  let release: GithubReleaseResponse;
  try {
    const res = await fetch(API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      // Don't poison the cache on transient failures — let next startup retry.
      return cache?.info ?? null;
    }
    release = (await res.json()) as GithubReleaseResponse;
  } catch {
    return cache?.info ?? null;
  }

  if (release.draft || release.prerelease) {
    writeCache({ checkedAt: Date.now(), info: null });
    return null;
  }

  const latest = release.tag_name.replace(/^[vV]/, "");
  const info: UpdateInfo | null =
    compareVersions(latest, current) > 0
      ? {
          current,
          latest,
          url: release.html_url,
          notes: release.body ?? "",
        }
      : null;

  writeCache({ checkedAt: Date.now(), info });
  return info;
}
