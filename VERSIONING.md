# Versioning

Studio is developed in one repository and forked in others, and the forks keep
merging the original back in. Two people running "AIPLAY Studio" can therefore
be running different programs, and Collab means their machines now exchange
files. So the app says which build it is, and it says it in a way that survives
being forked.

**There are two numbers, and they answer different questions. Keep them apart.**

| | What it answers | When it moves |
|---|---|---|
| **The build line** | Which build am I on, whose is it, how old | Every commit |
| **The protocol number** | Can my friend's Studio open my file | Only when the packet format or its rules change |

A restyled screen changes the build line. If one number did both jobs, that
restyle would tell two friends they can no longer work together, which is a lie
that costs someone an evening.

## The build line

```
B 26.09.20 · f9737e5 · based on S 26.09.20 · 88b607e
└─┬─┘ └──┬───┘  └──┬──┘             └──┬──┘
  │      │         │                   └─ the ORIGINAL's commit this build contains
  │      │         └───────────────────── this build's commit
  │      └─────────────────────────────── the date of that commit, YY.MM.DD
  └────────────────────────────────────── the lineage: S for the original, a letter per fork
```

Nothing here is typed by hand. `server/version.js` derives all of it:

1. **From git**, on a machine that has the clone. The build's commit and date
   come from `HEAD`; the base comes from `git merge-base HEAD upstream/main`.
2. **From `server/version.gen.json`**, for an install with no `.git`. Two things
   write it: `scripts/package.mjs` into the zip, and `AIPLAY Studio Setup.exe`
   from the commit it downloaded, alongside an `install-info.json` that names
   the repository it came from.
3. **From `server/version.archive.json`**, for a GitHub "Download ZIP". GitHub
   builds those zips with `git archive`, which fills in the file's
   `$Format:%h$` / `$Format:%cI$` placeholders because `.gitattributes` marks
   it `export-subst`. A clone keeps the placeholders and ignores the file.
4. **From none of these**: the build says "unknown" rather than inventing a number.

Uncommitted edits show as **modified**, because a bug report that names a clean
commit which does not match the running code wastes the day of whoever reads it.

### The date is the version

No major/minor/patch. Deciding whether something is "minor" is an argument
nobody wins, and the useful questions about a build are *how old* and *whose*.
Two builds on one day get a letter: `26.09.20b`.

### Where the lineage comes from

`package.json`, in one block. **The original repository carries no such block**,
and that absence is how a build knows it is the original: no block means letter
`S` and no base line.

A fork adds it:

```json
"aiplay": {
  "lineage": {
    "letter": "B",
    "name": "Bucky",
    "repo": "bani4kaskashka/AIPLAY-Studio-Bucky-Fork",
    "upstream": { "repo": "Senzube4n/AIPLAY-Studio", "commit": "88b607e…", "date": "2026-09-20T…" }
  }
}
```

`upstream.commit` is written by `node scripts/stamp-lineage.mjs`, which runs
`git merge-base HEAD upstream/main`.

> **A pull from upstream is not finished until this has run.** It is one command
> and it is part of the merge, not a chore afterwards. `RELEASING.md` says the
> same thing to an assistant (`CLAUDE.md` is git-ignored here, so it cannot).
> If the merge removed the fork's block, as the original's merges of a fork do,
> the script restores it for a clone whose `origin` is a fork it knows.
>
> ```bash
> git merge upstream/main && node scripts/stamp-lineage.mjs
> ```

A developer's clone recomputes it live and ignores a stale stamp — and says the
stamp is stale — but a zip or a plain clone has no `upstream` remote and can
only carry what was written down.

Pick a letter that is not taken. `S` is the original.

## The protocol number

`PACKET_V` in `server/collab/packet.js`, an integer, currently **1**. Every
Collab packet carries it as `v`. Two Studios can exchange files when they agree
on it, whatever builds they are running, and that comparison happens offline
from what each build already carries — never over the network.

Move it only when an older client would get something wrong: a field that
changes meaning, a rule that changes, anything sealed differently. Adding a
field an older client ignores harmlessly is not a reason to move it.

**When you move it**, say in this file what an older client does with a newer
packet, so the other side can write the refusal message.

| Protocol | Shipped | An older client sees |
|---|---|---|
| 1 | first Collab release | — |

The check itself is `speaks()` in `server/collab/compat.js`, and it reads the
packet's own `v` and nothing else. A packet from a NEWER protocol is refused at
the door before it is described or acted on, with a sentence naming both
numbers; an OLDER one opens and says so. Everything sealed also carries a
caption, `by: { app, commit, protocol }`, which is what a friend's row shows —
a caption, never a gate.

## Where it shows

- **Welcome**, small, under the ways in.
- **About**, as a block, with the only button in the app that asks GitHub
  anything (`Check for updates`).
- **The launcher's footer**, from the same two modules, so the two can never
  disagree.
- `GET /api/version` for anything else, including an agent.

## The update check

`server/updates.js`, two public `GET`s to `api.github.com`, no account, no
token, nothing about the machine sent. It asks:

- what the original's `main` is now, and
- `compare/<the upstream commit this build contains>...main`, which answers with
  **how many commits are on top of the base this build was made from** rather
  than comparing dates.

A fork also asks its own repository, so somebody running an old copy of a fork
is told. The answer is cached for an hour; GitHub allows 60 anonymous requests
an hour per address. A refusal, a rate limit or no connection come back as one
sentence and change nothing else.

This is the fourth place Studio touches the internet (Community's feed, the
model catalogue, the engine installer, and this), and like the others it is a
person's press.

**It is never on Collab's path.** Whether a friend's file opens is answered from
the packet's own number, offline, and no failure to reach GitHub can change that
answer.
