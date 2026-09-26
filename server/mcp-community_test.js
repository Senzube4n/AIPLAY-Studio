import test from "node:test";
import assert from "node:assert/strict";
import { communityTools, publicCommunitySnapshot } from "./mcp-community.js";
import { TOOLS } from "./mcp.js";
import { ROUTABLE } from "./chat/router.js";

test("community discovery is a registered read-only call to the page's existing route", async () => {
  const calls = [];
  const api = async (...args) => {
    calls.push(args);
    return { offline: false, sessions: [{ title: "Live room", host: "DJ", url: "https://aiplay.live/sessions/1" }] };
  };
  const tool = communityTools(api)[0];
  const result = await tool.run({});
  assert.equal(TOOLS.filter(item => item.name === tool.name).length, 1);
  assert.equal(ROUTABLE.community_feed, null);
  assert.deepEqual(calls, [["GET", "/api/community"]]);
  assert.equal(result.sessions[0].title, "Live room");
  assert.equal(result.sessions[0].submissionsOpen, null);
});

test("community projection caps records and drops fields outside public discovery", () => {
  const feed = {
    offline: true,
    sessions: Array.from({ length: 25 }, (_, i) => ({
      title: "x".repeat(500), host: "host", url: "javascript:alert(1)",
      submissionsOpen: i % 2 === 0, slotsFree: -1, privateToken: "secret", queue: ["private"],
    })),
    stations: [{ name: "station", viewers: 10, live: false, secret: "hidden" }],
    tracks: [{ title: "recent", artist: "artist", url: "https://aiplay.live/t/1", privateNotes: "hidden" }],
    articles: [{ title: "story", likes: 0, draftBody: "hidden" }],
    account: { id: "private" },
  };
  const snapshot = publicCommunitySnapshot(feed, "2026-09-26T00:00:00.000Z");
  assert.equal(snapshot.sessions.length, 20);
  assert.equal(snapshot.sessions[0].title.length, 160);
  assert.equal(snapshot.sessions[0].url, null);
  assert.equal(snapshot.sessions[0].slotsFree, null);
  assert.equal(snapshot.sessions[0].submissionsOpen, true);
  assert.equal(snapshot.offline, true);
  assert.equal(snapshot.stations[0].live, false);
  assert.equal(snapshot.articles[0].likes, 0);
  for (const value of ["privateToken", "queue", "privateNotes", "draftBody", "secret", "account"]) {
    assert.equal(JSON.stringify(snapshot).includes(value), false, value);
  }
});

test("missing live state and submission permission remain unknown", () => {
  const snapshot = publicCommunitySnapshot({ sessions: [{}], stations: [{}] }, "now");
  assert.equal(snapshot.sessions[0].submissionsOpen, null);
  assert.equal(snapshot.stations[0].live, null);
});
