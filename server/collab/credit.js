/**
 * WHO DID WHAT — the credit list, folded out of the ledger.
 *
 * The owner asked for this in one sentence: "credit of each project needs to be
 * recorded by who does what also in p2p collab format whos agent did what who's
 * users did what." The recording half already happened. Every event in
 * `server/provenance.js` carries an `actor` stamped at the door it came through
 * — `user` for a browser, `agent:<name>` for an MCP client, `script:<name>` for
 * a harness. What was missing was the READING: a hundred thousand JSON lines
 * are not a credit list.
 *
 * ⚠ HOW MUCH THE STAMP ACTUALLY PROVES, stated exactly, because the first draft
 * of this header overclaimed it twice and a credit list is precisely the
 * document where an overclaim does damage.
 *
 *   It proves   that the caller could not call ITSELF the person. `actorFrom`
 *               records `user` only when the actor header is ABSENT, which is
 *               the shape of a browser; a caller that sends one and claims to
 *               be the user is recorded `system`.
 *
 *   It does NOT prove   which agent. A caller chooses its own NAME verbatim, so
 *               `agent:plan` and `agent:mcp` are self-reported labels, and
 *               nothing stops one from calling itself the other.
 *
 *   The chain does NOT prove   that the ledger was not rewritten. It is a hash
 *               chain over a local file, so it catches a line ALTERED in place
 *               and nothing else; provenance.js says so in its own header, and
 *               anyone who can write the file can rewrite the chain. What it
 *               gives you is that tampering cannot be silent — which is why the
 *               route runs `verify()` and prints the answer instead of leaving
 *               a reader to assume it passed.
 *
 * ⚠ AND IT COUNTS ACTS, NOT MERIT. Ten `edit` events can be one person nudging a
 * slider ten times; one `generate` can be the shot the whole film turns on. The
 * rows are ORDERED by event count, which is itself only a count, and first
 * position in a credit list reads as principal — so the ordering is a weighting
 * even though nothing else here is one. A credit list built from this is the
 * start of a conversation between collaborators, not a settlement.
 *
 * THE FIFTH ACTOR CLASS. A take that came back from a friend's machine is
 * neither this machine's user nor this machine's agent, and flattening it into
 * either would be the one lie that makes the whole ledger worthless. It records
 * as `peer:<fingerprint>:<their own actor>` — their user, their agent, their
 * script, kept whole underneath their fingerprint. `server/collab/quarantine.js`
 * writes it when a returned take is adopted — this module was built first, and
 * read the shape for a year of an afternoon before the writer existed, which is
 * the right order: the alternative is discovering on the day the writer lands
 * that the credit list has to be redesigned to notice it.
 */

/** `peer:<32 hex>:<whatever their own door stamped>`. */
const PEER_RE = /^peer:([0-9a-f]{32}):(.+)$/;
const AGENT_RE = /^agent:(.+)$/;
const SCRIPT_RE = /^script:(.+)$/;

/** The kinds of hand a line in a credit list can come from. */
export const ACTOR_KINDS = Object.freeze(["user", "agent", "script", "peer", "system", "unrecorded"]);

/**
 * Take an actor string apart without losing anything.
 *
 * Returns `{ kind, name, peerFp, inner }`. For a peer, `inner` is the actor
 * string their own machine stamped, parsed the same way — so a friend's agent
 * reads as an agent that belongs to a friend, rather than as ours or as noise.
 *
 * ⚠ AN ACTOR THIS CANNOT PARSE IS `unrecorded`, NOT `system`, AND THE DIFFERENCE
 * IS WHO GETS THE CREDIT. `system` prints as "this machine", which is a positive
 * claim about the local owner — and the old fallback handed that claim to every
 * string it did not recognise: a friend's fingerprint one character short, an
 * actor class written by a newer version of the app, an empty string, a number.
 * Every one of them was awarded to the person reading the list, who is exactly
 * the party that benefits. Only the literal `system` is this machine now.
 *
 * ⚠ AND A NESTED `peer:` IS REFUSED RATHER THAN UNWRAPPED. `peer:<A>:peer:<B>:user`
 * would have credited B's work to A's fingerprint under the label "A's peer you",
 * with B's fingerprint absent from the list of machines that touched the project
 * — a relay absorbing a third party's work. The recursion was also unbounded: a
 * twenty-thousand-deep string threw a RangeError out of the fold, which the
 * route turned into a 500 that made the project's credit list permanently
 * unreadable with no sign of which line did it.
 */
export function readActor(actor) {
  const s = String(actor ?? "").trim().toLowerCase();
  const peer = PEER_RE.exec(s);
  if (peer) {
    if (/^peer:/.test(peer[2])) return { kind: "unrecorded", name: s, peerFp: null, inner: null };
    const inner = readActor(peer[2]);
    if (inner.kind === "unrecorded") return { kind: "unrecorded", name: s, peerFp: null, inner: null };
    return { kind: "peer", name: inner.name, peerFp: peer[1], inner };
  }
  const agent = AGENT_RE.exec(s);
  if (agent) return { kind: "agent", name: agent[1], peerFp: null, inner: null };
  const script = SCRIPT_RE.exec(s);
  if (script) return { kind: "script", name: script[1], peerFp: null, inner: null };
  if (s === "user") return { kind: "user", name: "you", peerFp: null, inner: null };
  if (s === "system") return { kind: "system", name: "system", peerFp: null, inner: null };
  return { kind: "unrecorded", name: s, peerFp: null, inner: null };
}

/** A timestamp the ledger might carry, as one comparable type or null.
 *  The real ledger writes ISO strings and the tests wrote numbers; compared
 *  against each other, `number < string` is always false, so a 2023 timestamp
 *  beside two 2026 ones silently vanished from both ends of the range. */
function stamp(t) {
  if (typeof t === "number" && Number.isFinite(t)) return new Date(t).toISOString();
  if (typeof t === "string" && t) return t;
  return null;
}

/**
 * Fold a project's events into one row per hand.
 *
 * `names` maps a peer fingerprint to the nickname on the roster, so a credit
 * list reads "bucky's agent" rather than thirty-two hex characters. It is passed
 * in rather than read here, because this module has no business opening a
 * roster — and because the rollup must work on a ledger belonging to a project
 * somebody else owns, where the fingerprints are not on our roster at all.
 */
export function creditRollup(events = [], { names = {} } = {}) {
  const rows = new Map();
  let counted = 0, skipped = 0;
  for (const e of Array.isArray(events) ? events : []) {
    /* An array is `typeof "object"` and is not an event; a ledger line of
     * `null` or `42` is valid JSON and is not an event either. */
    if (!e || typeof e !== "object" || Array.isArray(e)) { skipped++; continue; }
    const key = String(e.actor ?? "").trim().toLowerCase() || "system";
    let row = rows.get(key);
    if (!row) {
      const who = readActor(key);
      row = {
        actor: key,
        kind: who.kind,
        /* A peer's line says whose machine AND which hand on it; an actor
         * nothing recognised is shown as itself rather than dressed up. */
        label: who.kind === "peer"
          ? `${names[who.peerFp] || who.peerFp.slice(0, 8)}'s ${who.inner.kind === "user" ? "own hand" : `${who.inner.kind} ${who.inner.name}`}`
          : who.kind === "user" ? "you"
            : who.kind === "system" ? "this machine"
              : who.kind === "unrecorded" ? `an unrecorded hand (${who.name || "no actor at all"})`
                : `${who.kind} ${who.name}`,
        peerFp: who.peerFp,
        /* Carried so a caller can answer "whose AGENT did what" without
         * re-parsing the actor string this module exists to have parsed once. */
        innerKind: who.inner?.kind ?? null,
        innerName: who.inner?.name ?? null,
        events: 0, types: {}, assets: new Set(), firstAt: null, lastAt: null,
      };
      rows.set(key, row);
    }
    counted++;
    row.events++;
    const t = typeof e.type === "string" && e.type ? e.type : "(no type)";
    row.types[t] = (row.types[t] || 0) + 1;
    if (typeof e.asset === "string" && e.asset) row.assets.add(e.asset);
    const at = stamp(e.t);
    if (at !== null) {
      if (row.firstAt === null || at < row.firstAt) row.firstAt = at;
      if (row.lastAt === null || at > row.lastAt) row.lastAt = at;
    }
  }
  const people = [...rows.values()]
    .map((r) => ({ ...r, assets: r.assets.size }))
    .sort((a, b) => b.events - a.events);
  return {
    /* ⚠ `events` IS WHAT WAS COUNTED, not what was handed in, and `skipped` is
     * the difference. They used to be the same number, so a ledger with four
     * unreadable lines reported five acts and folded two — and the page printed
     * the five as its headline. */
    events: counted,
    skipped,
    people,
    byKind: ACTOR_KINDS.reduce((o, k) => {
      o[k] = people.filter((p) => p.kind === k).reduce((n, p) => n + p.events, 0);
      return o;
    }, {}),
    peers: [...new Set(people.filter((p) => p.peerFp).map((p) => p.peerFp))],
  };
}

/** English plural for a verb this module chose, including the ones that do not
 *  take a bare "s" — "2 analysiss" shipped, which is how this exists. */
const plural = (w, n) => (n === 1 ? w : /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : `${w}s`);

/**
 * The rollup as lines a person can read, and the sentence that keeps them
 * honest.
 *
 * ⚠ THE CAVEAT IS PART OF THE OUTPUT, not a footnote a caller may drop. These
 * are counts of recorded acts, and the ordering is itself a weighting.
 *
 * ⚠ AND THE LINE SAYS ITS OWN TOTAL, because it names only the four commonest
 * kinds of act. A hand that did five different small things was silently
 * shrunk against one that did the same thing repeatedly: eight types, four
 * printed, eighteen of fifty-two acts vanished with nothing to notice them
 * against. The total is now on the line and the remainder is named.
 */
export function creditLines(rollup, { verbs = DEFAULT_VERBS } = {}) {
  const lines = (rollup?.people || []).map((p) => {
    const all = Object.entries(p.types).sort((a, b) => b[1] - a[1]);
    const shown = all.slice(0, 4);
    const did = shown.map(([t, n]) => `${n} ${plural(verbs[t] || t, n)}`).join(", ");
    const restKinds = all.length - shown.length;
    const restActs = all.slice(4).reduce((n, [, c]) => n + c, 0);
    /* ⚠ "files" WAS A LIE ON THE ONLY REAL FILM IN THE REPO. Every one of
     * hex-appeal's events carries the single asset `mv/hex-appeal`, so 250 acts
     * read "across 1 file". The word is "subject" because that is what the
     * ledger's `asset` is, and the clause is dropped when there is only one. */
    const where = p.assets > 1 ? `, across ${p.assets} subjects` : "";
    return `${p.label} — ${p.events} recorded ${plural("act", p.events)}: ${did}`
      + (restKinds ? `, and ${restActs} more of ${restKinds} other ${plural("kind", restKinds)}` : "")
      + where;
  });
  return {
    lines,
    note: "Counts of recorded acts, not a measure of contribution: ten edits can be "
        + "one slider nudged ten times, and one render can be the shot the whole thing turns on. "
        + "The rows are ordered by how many acts each hand recorded, which is also only a count. "
        + "Each act was stamped at the door it came through, so a caller cannot claim to be the person "
        + "at the keyboard — but an agent does choose its own name.",
  };
}

/** Plain words for the ledger's event types, so a credit line is a sentence. */
export const DEFAULT_VERBS = Object.freeze({
  generate: "render", record: "recording", edit: "edit", import: "import",
  export: "export", plan_step: "planned step", analyze: "analysis run", derive: "derivation",
  /* Read off a real film's ledger rather than guessed: hex-appeal's events are
   * generate, plan_step, choice and regen. No count is written here — the one
   * that was drifted twice while a reviewer was reading it. A type with no word
   * prints as its own name, which is why `(no type)` is spelled out above
   * rather than left to print as "?". */
  choice: "decision", regen: "re-render",
});
