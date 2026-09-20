/**
 * COLLAB OVER MCP — the address book, the two couriers, and what arrives.
 *
 * Everything the Collab screen does, an agent can do too, with three
 * exceptions that are the feature rather than gaps in it:
 *
 *  - **An agent may not verify a friend.** Verification is a person reading
 *    twelve words aloud to another person and both saying they match. A tool
 *    that flips that flag is a tool that grants trust nobody granted, so there
 *    is no `collab_verify` and the description says why rather than leaving an
 *    absence for somebody to fill in.
 *  - **An agent may not lend the card.** `collab_set_lend_minutes` does not
 *    exist. How much of a machine a friend may have is a number its owner
 *    types, once, while the question is still calm.
 *  - **An agent may not render what arrives.** `collab_open` reads a bundle,
 *    checks its signature and says what is in it. Turning that into work is a
 *    separate, human act on the screen, because a bundle is a stranger's
 *    sentence until somebody reads it.
 *
 * What an agent MAY do is the useful half: say who you are, keep the roster,
 * and pack a scene or a project for somebody who is expecting it.
 *
 * ⚠ NOTHING HERE OPENS A SOCKET. Phase one is a file you send however you
 * already send files; the tools write it and read it, and the network is the
 * one you already have.
 */

export function collabTools(api, safeName) {
  return [
    {
      name: "collab_me",
      description:
        "WHO THIS STUDIO IS TO OTHER STUDIOS. Answers the machine's own fingerprint (128 bits over both public "
        + "keys), the twelve words that fingerprint reads as, the one-line key card to give a friend, and how the "
        + "private key file is protected on this platform. The keypairs are made on the FIRST call and never at "
        + "boot, so a Studio that never collaborates never has an identity. Nothing here is secret: the key card "
        + "is meant to be pasted into a chat. The private keys stay on disk and no tool returns them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await api("POST", "/api/collab", { action: "me" });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_roster",
      description:
        "WHO THIS STUDIO KNOWS. Every friend: their fingerprint, the name you gave them, whether the twelve words "
        + "were ever read aloud (`verified`), what they are to you (`role`: none, lender or collaborator) and how "
        + "many minutes of this card they may have in a day. A peer that is not verified may RECEIVE from you and "
        + "may not be given a role — the roster enforces that, not the screen.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await api("POST", "/api/collab", { action: "roster" });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_add_peer",
      description:
        "ADD A FRIEND from the key card they sent you — the one line beginning AIPLAY1: that collab_me answers. "
        + "They arrive UNVERIFIED, with no role and no minutes: adding somebody is not trusting them. To finish, a "
        + "person has to read the twelve words to them and hear the same twelve back, and mark it on the Collab "
        + "screen; no tool can do that step, because a tool cannot hear anything. Refuses a card whose two keys do "
        + "not produce the fingerprint it claims, and refuses a fingerprint already on the roster — if their keys "
        + "really changed, remove them first and verify the new card aloud again.",
      inputSchema: {
        type: "object",
        required: ["card"],
        properties: {
          card: { type: "string", description: "The whole key-card line, AIPLAY1:<fingerprint>:<sign>:<seal>:<name>." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/collab", { action: "add_peer", card: String(a.card || "") });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_set_role",
      description:
        "WHAT A FRIEND IS TO YOU, and it decides what leaves this machine. `collaborator` receives whole projects "
        + "— boards, cast, bibles, the plan — because they are making the thing with you. `lender` receives a SHOT "
        + "PACKET and nothing else: one finished prompt, the reference pictures that prompt needs, and the render "
        + "settings. A lender never sees the script, the song, the other scenes or the plan. `none` is neither. "
        + "Refused on a peer whose twelve words were never read aloud, with reason not-verified — the roster "
        + "refuses it, so this cannot be worked around by another door.",
      inputSchema: {
        type: "object",
        required: ["fp", "role"],
        properties: {
          fp: { type: "string", description: "The friend's 32-character fingerprint, from collab_roster." },
          role: { type: "string", enum: ["none", "lender", "collaborator"] },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/collab", { action: "set_role", fp: String(a.fp || ""), role: String(a.role || "") });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_pack",
      description:
        "PACK SOMETHING FOR A FRIEND, sealed to them and signed by you. Two kinds, and the friend's ROLE decides "
        + "which one they may have.\n\n"
        + "`shot` is for a LENDER: one scene of one project as a finished prompt, the reference pictures it needs, "
        + "and the render settings. The prompt is composed HERE, by you, because the receiving Studio prepends its "
        + "own style bible to anything it composes itself — a packet carries the finished sentence so their bible "
        + "never reaches your scene.\n\n"
        + "`project` is for a COLLABORATOR: the whole document and a manifest of the assets it references.\n\n"
        + "Writes one file and answers where it is and what it weighs. Send it however you already send files; "
        + "nothing here opens a connection. Sealed to that one friend's key, so a copy that reaches somebody else "
        + "is bytes.",
      inputSchema: {
        type: "object",
        required: ["to", "kind"],
        properties: {
          slug: { type: "string", description: "The project." },
          to: { type: "string", description: "The friend's fingerprint, from collab_roster." },
          kind: { type: "string", enum: ["shot", "project", "resources"], description: "resources: what this Studio can do. A verified friend may have that one with no role at all." },
          segment: { type: "string", description: "kind shot: which scene, e.g. s1_24." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/collab", {
          action: "pack",
          slug: a.slug ? safeName(a.slug, "project") : undefined,
          to: String(a.to || ""),
          kind: String(a.kind || ""),
          segmentId: a.segment ? String(a.segment) : undefined,
        });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_resources",
      description:
        "WHAT THIS STUDIO CAN DO, and what each friend last said THEY could do. Answers this machine's card, its "
        + "memory and the ids of the catalogue capabilities that are fully downloaded — ids from a list every "
        + "Studio already has, never file names — plus, for each peer, the resource card they last sent and how "
        + "old it is. Use it before asking a friend for a scene: a friend without the weights cannot take it, and "
        + "finding that out by sending them one and waiting an hour is the bad version of this. ⚠ A FRIEND'S CARD "
        + "IS A MESSAGE, NOT A READING: it is what their machine could do at the moment they pressed send, and "
        + "nothing here probes anybody. Say the age out loud when you quote one. Sending yours is collab_pack with "
        + "kind \"resources\"; a verified friend may have it with no role at all, because saying what your machine "
        + "can do is how two people decide whether to lend to each other.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const [mine, roster] = await Promise.all([
          api("POST", "/api/collab", { action: "resources" }),
          api("POST", "/api/collab", { action: "roster" }),
        ]);
        if (mine?.error) throw new Error(mine.error);
        if (roster?.error) throw new Error(roster.error);
        return {
          mine: mine.resources,
          friends: (roster.peers || []).map((p) => ({
            fp: p.fp, nickname: p.nickname, verified: !!p.verified, role: p.role,
            resources: p.resources || null, saidAt: p.resourcesAt || null,
          })),
        };
      },
    },

    {
      name: "collab_credit",
      description:
        "WHO DID WHAT ON A PROJECT — folded out of its provenance ledger, not out of the document. Every event "
        + "carries an actor stamped at the door it came through (a browser is `user`, an MCP client is "
        + "`agent:<name>`, a harness is `script:<name>`, a friend's returned work is "
        + "`peer:<fingerprint>:<their own actor>`), the ledger is hash-chained, and no caller can write itself "
        + "into it — which is why this reads events instead of a contributors field somebody could edit. Answers "
        + "one row per hand with what it did and how many files it touched, the totals by kind, and ready-made "
        + "lines for a credit list. ⚠ IT COUNTS ACTS AND NOT MERIT: ten edits can be one slider nudged ten times "
        + "and one render can be the shot the whole thing turns on. Quote the note it returns alongside the lines; "
        + "a credit list handed over without it reads as a settlement, and it is not one.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: { slug: { type: "string", description: "The project." } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/collab", { action: "credit", slug: safeName(a.slug, "project") });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },

    {
      name: "collab_open",
      description:
        "READ A BUNDLE A FRIEND SENT, and say what is in it — WITHOUT rendering anything. Checks the signature "
        + "first, then that it was sealed to this machine, then decrypts; a bundle that fails any of those is "
        + "refused by name (bad-signature, not-for-me, bad-ciphertext) and nothing is written. What comes back is "
        + "who sent it, whether their twelve words were ever read aloud, what kind it is, and one sentence saying "
        + "what it would cost to accept.\n\n"
        + "⚠ It stops there ON PURPOSE. A bundle is a sentence written by somebody else; turning one into work on "
        + "your card is a person's decision, taken on the Collab screen with the prompt in front of them.",
      inputSchema: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "string", description: "A path to the bundle file, or its name inside the collab inbox." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/collab", { action: "open", file: String(a.file || "") });
        if (r?.error) throw new Error(r.error + (r.reason ? ` (${r.reason})` : ""));
        return r;
      },
    },
  ];
}
