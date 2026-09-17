/**
 * THE CREDITS ON THE THANKS PAGE.
 *
 * Source contracts only — this suite never opens a browser. What it defends is
 * the one thing a credits list can quietly get wrong: drifting apart from the
 * page that shows it. The names live in ONE table (web/credits.js); the markup
 * is generated from that table; the classes that markup emits must all exist in
 * the stylesheet, or a person's name renders as unstyled text nobody reads.
 *
 * It also holds the list to the standard the rest of the Thanks page is held
 * to. That page sits beside a licence table whose every number is read live
 * from the catalogue precisely so it cannot exaggerate. A credits list with an
 * empty role, a duplicated name or an http:// link makes the table beside it
 * look like marketing too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PEOPLE, creditsHtml } from "../web/credits.js";

/** What the renderer does to text, so an expectation reads the same way. */
const esc = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("every credit says who, what they are, and what they did", () => {
  assert.ok(PEOPLE.length >= 2, "a credits page with one name is a byline");
  for (const p of PEOPLE) {
    assert.ok(p.name?.trim(), "a person needs a name");
    assert.ok(p.role?.trim(), `${p.name} needs a role`);
    // A role that is a whole paragraph belongs in `did`; the chip has one line.
    assert.ok(p.role.length <= 48, `${p.name}'s role is a chip, not a sentence`);
    assert.ok(p.did && p.did.length >= 60,
      `${p.name} needs a real description, not a job title repeated`);
    // The list is built to stay short as it grows: one sentence, four lines.
    assert.ok(p.did.length <= 320, `${p.name}'s entry is longer than its row's budget`);
    assert.ok(!p.areas || p.areas.every((a) => typeof a === "string" && a.trim() && a.length <= 24),
      `${p.name}'s areas must be short labels`);
    if (p.url) assert.match(p.url, /^https:\/\//, `${p.name}'s link must be https`);
    if (p.handle) assert.match(p.handle, /^@\S+$/, `${p.name}'s handle must read as one`);
  }
});

test("no name appears twice", () => {
  const seen = PEOPLE.map((p) => p.name.toLowerCase());
  assert.equal(new Set(seen).size, seen.length, "a duplicated credit is a merge that went wrong");
});

/* The split is not close, and the page is only honest if it says so: one
 * founder, at the top, marked — not three equal cards. */
test("the founder leads, and leads alone", () => {
  assert.equal(PEOPLE.filter((p) => p.lead).length, 1, "exactly one entry is the lead");
  assert.ok(PEOPLE[0].lead, "the lead is the first row, not one tinted somewhere down the list");
  assert.match(creditsHtml().slice(0, 40), /class="person lead"/);
});

test("the rendered card carries the whole entry, escaped", () => {
  const out = creditsHtml();
  for (const p of PEOPLE) {
    assert.ok(out.includes(esc(p.name)), `${p.name} is missing from the cards`);
    assert.ok(out.includes(esc(p.role)), `${p.name}'s role is missing`);
    for (const a of p.areas || []) assert.ok(out.includes(`<span>${esc(a)}</span>`), `${a} is missing`);
    if (p.url) assert.ok(out.includes(`href="${esc(p.url)}"`), `${p.name}'s link is missing`);
  }
  // Every outward link opens away from the app, and cannot reach back into it.
  for (const m of out.matchAll(/<a\b[^>]*>/g)) {
    assert.match(m[0], /target="_blank"/);
    assert.match(m[0], /rel="noopener"/);
  }
  const nasty = creditsHtml([{
    name: '<script>x</script>', role: "Role", areas: ['"><b>'],
    did: "x".repeat(60), url: "https://example.com/?a=1&b=2",
  }]);
  assert.ok(!nasty.includes("<script>"), "a name is text, not markup");
  assert.ok(!nasty.includes('""'), "an area is text, not an attribute");
});

test("the page mounts the credits and loads the table that fills it", () => {
  assert.match(html, /<div id="thanksPeople" class="people"><\/div>/,
    "the Thanks page needs the mount web/credits.js writes into");
  assert.match(html, /<script type="module" src="credits\.js"><\/script>/,
    "nothing fills the mount unless the module is loaded");
  // The people come before the licences: the point of the rewrite.
  const thanks = html.slice(html.indexOf('<div id="thanks"'));
  assert.ok(thanks.indexOf('id="thanksPeople"') < thanks.indexOf('id="thanksModels"'),
    "the people belong above the model table");
  assert.ok(thanks.indexOf("The people") < thanks.indexOf("The models"));
});

test("every class the cards emit is styled", () => {
  const emitted = [...creditsHtml().matchAll(/class="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/));
  for (const cls of new Set([...emitted, "people"])) {
    assert.ok(new RegExp(`\\.${cls}\\b`).test(css),
      `.${cls} is rendered by web/credits.js and has no rule in styles.css`);
  }
  // ONE framed list with hairline-separated rows, not a card per person: the
  // card grid was three scrolls at three names and this list is meant to grow.
  assert.match(css, /\.people\{[^}]*border-radius:12px/);
  assert.match(css, /\.person\+\.person\{[^}]*border-top:/);
  assert.match(css, /\.person\.lead\{/);
  assert.ok(!/\.person\.wide/.test(css), "the card-grid override outlived the card grid");
});

/**
 * AND THE TABLE UNDERNEATH THE CREDITS.
 *
 * The licence field carries a NAME and, where one is needed, the explanation
 * that goes with it — up to 365 characters of it on Ideogram's row. The page
 * put the whole string inside the pill beside the model, and four sentences in
 * a shape built for two words rendered as a tall ribbon a few words wide, in
 * the one column on the page a reader most needs to be able to read.
 *
 * The fix splits on the catalogue's own punctuation, so it only works while the
 * catalogue keeps writing `Name — explanation`. That is the part worth pinning:
 * a new entry with a paragraph and no dash puts the ribbon straight back.
 */
test("a long licence is a name plus a note, not a paragraph in a pill", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /const \{ name, note \} = licenceParts\(c\.licence\);/,
    "the Thanks table must split the licence before it renders the pill");
  assert.match(app, /<span class="lic">\$\{esc\(name\)\}<\/span>/,
    "the pill gets the name; the sentences go to their own line");
  assert.match(css, /\.thanksrow \.licnote\{[^}]*grid-column:1\/-1/,
    "the note runs the row's full width, which was the whole point");
  // The description and the rights chip span by declaration now: they used to
  // be placed by arithmetic, and the rows carrying a support link pushed the
  // description into a 9rem column.
  assert.match(css, /\.thanksrow \.why\{[^}]*grid-column:1\/-1/);
  assert.match(css, /\.rightsrow \.rights\{[^}]*grid-column:1\/-1/,
    "the About page opens the same licence text; it gets the full row too");
});

test("every licence in the catalogue can be split into a pill-sized name", async () => {
  const { CATALOG } = await import("./models.js");
  for (const c of CATALOG) {
    const s = String(c.licence || "");
    /* Under ~100 characters it is still a name — sometimes three of them joined
     * by "·" — and a pill can hold it on two lines. Past that it is prose. */
    if (s.length <= 100) continue;
    const cut = s.indexOf(" — ");
    assert.ok(cut > 0 && cut <= 64,
      `${c.id}: a licence this long needs its name separated by " — " — got ${JSON.stringify(s.slice(0, 70))}`);
  }
});
