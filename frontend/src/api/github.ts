/**
 * GitHub release lookup for the in-app "new version available" badge.
 *
 * Direct browser → api.github.com fetch — read-only public endpoint,
 * no auth needed. Rate limit is generous (60 req/hr unauthenticated)
 * and we cache the result in sessionStorage so a page refresh re-uses
 * what we already learned instead of burning quota.
 */

import packageJson from "../../package.json";

const REPO = "Mon-Knight/AI-Canvas-Studio";
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "flowboard.github.latestRelease.v2";
const DISMISSED_KEY = "flowboard.github.dismissedReleaseTag.v1";
// 1 hour — long enough that idle tabs don't hammer the API, short
// enough that a freshly-cut release shows up the same session.
const CACHE_TTL_MS = 60 * 60 * 1000;

export const CURRENT_APP_VERSION: string = packageJson.version;

export interface LatestRelease {
  tagName: string; // e.g. "v1.4.0"
  name?: string;
  notes?: string;
  htmlUrl: string; // GitHub release page
  publishedAt: string; // ISO timestamp
  setupUrl?: string | null;
  portableUrl?: string | null;
}

interface CachedShape {
  fetchedAt: number;
  release: LatestRelease | null; // null = previous fetch found no release
}

function readCache(): CachedShape | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.fetchedAt !== "number") return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed as CachedShape;
  } catch {
    return null;
  }
}

function writeCache(shape: CachedShape): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(shape));
  } catch {
    // sessionStorage disabled / quota exceeded — non-fatal.
  }
}

export function getDismissedReleaseTag(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissReleaseTag(tag: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, tag);
  } catch {
    // localStorage disabled — non-fatal.
  }
}

export async function getLatestRelease(forceRefresh = false): Promise<LatestRelease | null> {
  if (!forceRefresh) {
    const cached = readCache();
    if (cached) return cached.release;
  }
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      // 404 = no published release yet. Cache as null so we don't
      // re-spam the endpoint for the next hour.
      writeCache({ fetchedAt: Date.now(), release: null });
      return null;
    }
    const body = await res.json();
    const assets: Array<{ name?: unknown; browser_download_url?: unknown }> = Array.isArray(body.assets)
      ? body.assets
      : [];
    const setupAsset = assets.find(
      (a) => typeof a.name === "string" && a.name.toLowerCase().endsWith("-setup.exe"),
    );
    const portableAsset = assets.find(
      (a) => typeof a.name === "string" && a.name.toLowerCase().endsWith("-portable.zip"),
    );
    const rawNotes = typeof body.body === "string" ? body.body.trim() : "";
    const release: LatestRelease = {
      tagName: typeof body.tag_name === "string" ? body.tag_name : "",
      name: typeof body.name === "string" ? body.name : undefined,
      notes: rawNotes ? rawNotes.slice(0, 240) : undefined,
      htmlUrl: typeof body.html_url === "string" ? body.html_url : "",
      publishedAt: typeof body.published_at === "string" ? body.published_at : "",
      setupUrl:
        typeof setupAsset?.browser_download_url === "string" ? setupAsset.browser_download_url : null,
      portableUrl:
        typeof portableAsset?.browser_download_url === "string"
          ? portableAsset.browser_download_url
          : null,
    };
    writeCache({ fetchedAt: Date.now(), release });
    return release;
  } catch {
    return null;
  }
}

/** Return true when `latest` is strictly newer than `current`. Both
 *  may be prefixed with "v" (e.g. "v1.2.3"); we strip + parse semver
 *  numerically to avoid string-compare surprises ("1.10.0" > "1.9.0"
 *  must hold). Falls back to `false` for malformed inputs so we never
 *  show a false-positive "New version" badge. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.replace(/^v/i, "").trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}
