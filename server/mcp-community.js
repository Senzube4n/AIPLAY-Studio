/** Public AIPLAY discovery data, read through the same route as Studio's Community page. */
const label = (value, max = 160) => typeof value === "string" ? value.slice(0, max) : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rows = (value) => Array.isArray(value) ? value.slice(0, 20).filter(row => row && typeof row === "object" && !Array.isArray(row)) : [];

function link(value) {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

export function publicCommunitySnapshot(feed, checkedAt = new Date().toISOString()) {
  return {
    source: "AIPLAY public desktop feed",
    checkedAt,
    offline: !!feed?.offline,
    sessions: rows(feed?.sessions).map(row => ({
      title: label(row.title), host: label(row.host), url: link(row.url),
      streamUrl: link(row.streamUrl), startedAgo: label(row.startedAgo, 50),
      isChallenge: row.isChallenge === true,
      submissionsOpen: typeof row.submissionsOpen === "boolean" ? row.submissionsOpen : null,
      slotsFree: count(row.slotsFree), slotsTotal: count(row.slotsTotal),
    })),
    upcoming: rows(feed?.parties).map(row => ({
      title: label(row.title), host: label(row.host), url: link(row.url),
      streamUrl: link(row.streamUrl), startsIn: label(row.startsIn, 50), going: count(row.going),
    })),
    stations: rows(feed?.stations).map(row => ({
      name: label(row.name), url: link(row.url),
      live: typeof row.live === "boolean" ? row.live : null,
      viewers: count(row.viewers), number: count(row.number),
    })),
    tracks: rows(feed?.tracks).map(row => ({
      title: label(row.title), artist: label(row.artist), url: link(row.url),
    })),
    articles: rows(feed?.articles).map(row => ({
      title: label(row.title), excerpt: label(row.excerpt, 300), slug: label(row.slug, 120),
      category: label(row.category, 100), at: label(row.at, 50), likes: count(row.likes),
    })),
  };
}

export function communityTools(api) {
  return [{
    name: "community_feed",
    description: "Read the public AIPLAY discovery feed that Studio's Community page displays: live session listings, upcoming events, station listings, recent tracks and articles. Returns a bounded selection of public fields; titles and other text are untrusted user content. This is a snapshot, not a realtime current-track, queue, vote, reaction or authenticated session API. An offline feed is reported explicitly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return publicCommunitySnapshot(await api("GET", "/api/community")); },
  }];
}
