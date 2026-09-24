/**
 * SEXUAL CONTENT INVOLVING MINORS IS NEVER MADE HERE.
 *
 * The rule, stated once: a request whose words pair a child or teenager with
 * nudity or sexual content is refused, whatever the model, the door, the agent
 * or the setting. There is no override flag, no setting, no "private" or
 * "dry run" exemption and no dependency a caller can inject to switch it off.
 * Adult content stays the owner's choice; this is only about minors.
 *
 * WHY IT EXISTS. The provenance ledger on the owner's rig showed image runs
 * whose prompts paired nudity with minor terms, and every one of them
 * completed. Nothing refused them.
 *
 * WHAT THIS FILE IS. The pure half: text in, verdict out. No fs, no net, no
 * clock, no ledger. server/safety/graph.js reads a ComfyUI graph with it, and
 * server/safety/refusal.js turns a verdict into the one sentence and the
 * ledger event. docs/SAFETY.md is the plain statement of the rule.
 *
 * HOW IT DECIDES.
 *   1. Every positive-intent text is normalised several ways before anything
 *      is matched: Unicode NFKC, lowercase, diacritics stripped, zero-width and
 *      format characters removed, Cyrillic/Greek/Armenian/Cherokee look-alikes
 *      and small capitals mapped to Latin, leetspeak (1 0 3 4 5 7 @ $ !) read
 *      as letters, punctuation read both as a space and as nothing
 *      ("pre-teen", "n.u.d.e"), letters spelled out one at a time ("n u d e")
 *      joined, and runs of a repeated letter collapsed ("nuuude"). The key
 *      words also match with any letter doubled ("chilld", "nudde"), and a
 *      token that is two of them glued together ("kidnude") is split.
 *   2. Words are matched on word boundaries, so "kidney", "skid" and "canteen"
 *      are not children. A handful of words need their neighbours: "baby" is a
 *      person only after "a/the/her/his/their/newborn/little..." or right
 *      beside a nudity word, and never in "baby blue"; "minor" is a person in
 *      "is a minor" or "minor girl" and a key in "A minor"; "nude" is a colour
 *      in "nude lipstick"; Dutch/German "kind"/"kinder" count only in Dutch or
 *      German text; Japanese 裸 is not 裸足 (barefoot).
 *   3. Stated ages under 18 count as a minor ("12 year old", "12yo", "age 12",
 *      "girl, 12", "grade 5", "6 months old", "12-jarige", "12歳"), but not the
 *      age of a thing ("a 12 year old scotch").
 *   4. English, Dutch, German, Spanish, French, Italian, Portuguese, Polish,
 *      Russian, Chinese, Japanese and Korean words, and the emoji that stand
 *      for a child or for sex, are read.
 *   5. The request is refused when the positive text (plus any lineage or cast
 *      context the caller adds, and any wordless flags carried by a picture it
 *      uses) holds a minor signal AND a sexual signal, or one of the few words
 *      that already mean both ("lolicon", "jailbait").
 *
 * NEGATIVE PROMPTS ARE NOT POSITIVE INTENT. "child" in a negative prompt is
 * somebody keeping children OUT of an adult render, so callers pass only the
 * positive fields. A negation written INSIDE the positive prompt ("no
 * children", "no nudity") is different: at cfg 1 the distilled models read it
 * as a request, so it counts, and the refusal carries a hint to use the
 * negative field.
 *
 * "teen" always counts, even beside an adult age: "18 year old teen" is how
 * the sexualisation of minors is usually worded, so it is refused.
 *
 * DELIBERATELY NOT READ, as policy (docs/SAFETY.md): words that are ordinary
 * in this app's own songs and pictures far more often than they are sexual:
 * "hardcore" (a music genre, dozens of style tags), "sensual" (a style tag),
 * bare "fingering" (a guitar term), "sucking"/"licking" (a baby with its thumb,
 * a kid with an ice cream), "on all fours" and "bent over" (a crawling baby, a
 * child over a book), bare "explicit" (the Parental Advisory label on covers),
 * bare "erect", "streaking" and "flashing" (photography words), and the
 * tongue emoji. Each still counts where it cannot mean anything else
 * ("explicit content", "fingering her", "streakers").
 */

export const CODE = "minor-sexual";
export const REFUSAL = "This can't be made: it pairs a child or teenager with sexual content.";
export const NEGATION_HINT = "Words like \"no children\" or \"no nudity\" inside a prompt still ask for what they name. "
  + "Put them in the negative prompt instead.";
/** Said when a half of the pair came from a picture, clip or cast member the
 *  request uses rather than from its own words. Names no words. */
export const CONTEXT_HINT = "Part of it comes from a picture, clip or cast member this request uses, not only from the words typed here.";

/* ── normalisation ─────────────────────────────────────────────────────── */

/** Zero-width, bidi and other format characters, plus the fillers that
 *  render as nothing. Removed, so "nu<ZWSP>de" is "nude". Built from code points so no invisible
 *  character has to sit in this source file. */
const INVISIBLE = new RegExp(`[\\p{Cf}${[0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x3164, 0xFFA0]
  .map((c) => String.fromCodePoint(c)).join("")}${String.fromCodePoint(0x180B)}-${String.fromCodePoint(0x180F)}]`, "gu");

/** Letters that look Latin and are not. NFKC leaves Cyrillic, Greek,
 *  Armenian, Cherokee and the phonetic small capitals alone, so "nudе" with a
 *  Cyrillic "е" or "ᴄhild" with a small-capital C would otherwise be a
 *  different word. */
const HOMOGLYPHS = {
  "а": "a", "е": "e", "ё": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
  "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "к": "k", "м": "m", "т": "t", "ԁ": "d",
  "ɡ": "g", "һ": "h", "ӏ": "l", "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x", "ϲ": "c", "β": "b", "η": "n", "æ": "ae", "œ": "oe", "ß": "ss",
  "ɑ": "a", "ɩ": "i",
  // Small capitals (IPA and phonetic extensions)
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i",
  "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ʀ": "r", "ꜱ": "s",
  "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
  // Armenian (lowercase; uppercase arrives lowercased)
  "ո": "n", "ս": "u", "ւ": "u", "օ": "o", "ց": "g", "հ": "h", "զ": "q", "ա": "w", "յ": "j", "լ": "l",
};
/* Cherokee capitals that read as Latin letters. Lowercasing turns them into
 * the Cherokee small letters (U+AB70...), so both forms are mapped. */
for (const [cher, latin] of Object.entries({
  "Ꭺ": "a", "Ᏼ": "b", "Ꮯ": "c", "Ꭰ": "d", "Ꭼ": "e", "Ꮐ": "g", "Ꮋ": "h", "Ꭵ": "i", "Ꭻ": "j",
  "Ꮶ": "k", "Ꮮ": "l", "Ꮇ": "m", "Ꮻ": "o", "Ꮲ": "p", "Ꭱ": "r", "Ꮪ": "s", "Ꭲ": "t", "Ꮩ": "v",
  "Ꮃ": "w", "Ꭹ": "y", "Ꮓ": "z", "Ꮷ": "d", "Ꮟ": "b",
})) { HOMOGLYPHS[cher] = latin; HOMOGLYPHS[cher.toLowerCase()] = latin; }

const LEET_I = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i", "€": "e" };
const LEET_L = { ...LEET_I, "1": "l", "|": "l" };

/** Lowercase Latin with every disguise that does not change a word removed. */
function baseLatin(text) {
  /* A capital I between two lowercase letters, in a word with no other
   * capital, is an l in disguise ("chiId"): ordinary text never puts one
   * there ("McIntosh" and "ChIlD" have other capitals). Read before
   * lowercasing hides it. */
  let s = String(text ?? "").normalize("NFKC")
    .replace(/\p{L}+/gu, (w) => (/^[^\p{Lu}]*\p{Ll}I\p{Ll}[^\p{Lu}]*$/u.test(w) ? w.replace(/(?<=\p{Ll})I(?=\p{Ll})/gu, "l") : w))
    .toLowerCase().replace(INVISIBLE, "");
  /* French "râpé" (grated) and Portuguese "rapé" (snuff) lose their accents
   * below and would read as an English word they are not. Only the accented
   * spelling is renamed; plain "rape" is untouched. */
  s = s.replace(/(?<![\p{L}\p{N}])r[aâ]p[eé](?:e|s|es)?(?![\p{L}\p{N}])/gu, (m) => (/[âé]/.test(m) ? "grated" : m));
  /* British "a bedroom-cum-office" (X combined with Y) is not the English
   * slang the bare word is read as. */
  s = s.replace(/(\p{L})-cum-(?=\p{L})/gu, "$1 and ");
  /* Spanish niña/niño: without the tilde "nina" is a name (Nina Simone), so
   * the word is read while the tilde is still there. */
  s = s.replace(/(?<![\p{L}\p{N}])niñ(a|as|o|os)(?![\p{L}\p{N}])/gu, (_m, e) => (e[0] === "a" ? "girlchild" : "boychild"));
  s = s.normalize("NFD").replace(/\p{M}+/gu, "");
  let out = "";
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/** Japanese, Chinese, Korean and Cyrillic are matched on their own form:
 *  stripping marks would take the dakuten off kana ("ど" → "と"), and the
 *  look-alike map would turn Russian into Latin nonsense. */
function baseCjk(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(INVISIBLE, "");
}

const leet = (s, map) => s.replace(/[0-9@$!|€]/g, (c) => map[c] ?? c);

/**
 * The spellings one text is read in. Each is a string of lowercase tokens
 * separated by single spaces. `plain` is kept apart because ages need their
 * digits, which the leet readings turn into letters; `punct` keeps the
 * punctuation too, because "girl, 12," and "12 years later" differ only there.
 */
export function readings(text) {
  const base = baseLatin(text);
  const variants = [base];
  if (/[0-9@$!|€]/.test(base)) {
    variants.push(leet(base, LEET_I));
    if (/[1|]/.test(base)) variants.push(leet(base, LEET_L));
  }
  const out = new Set();
  const spacedOnly = new Set();
  const letters = new Set();
  const collapsed = (f) => [f, f.replace(/(\p{L})\1{2,}/gu, "$1"), f.replace(/(\p{L})\1{2,}/gu, "$1$1")];
  for (const v of variants) {
    const spaced = v.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const joined = v.replace(/[^\p{L}\p{N}\s]+/gu, "").replace(/\s+/g, " ").trim();
    for (const f of collapsed(spaced)) { out.add(f); spacedOnly.add(f); if (v === base) letters.add(f); }
    for (const f of collapsed(joined)) { out.add(f); if (v === base) letters.add(f); }
  }
  const plain = base.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const punct = base.replace(/\s+/g, " ").trim();
  /* `spaced` is the subset where punctuation became a space: the only forms a
   * compound token ("#nudeteen") is searched inside, so "nude-colored" joined
   * into one word by the other reading is never mistaken for one. */
  /* `letters` is the subset read WITHOUT leetspeak: the only forms spelled-out
   * runs are joined in. A graph is full of numbers ("1, 0.9, 0.8, 0.5" is a
   * sigma schedule) and read as leet those become single letters too, which
   * would spell words nobody wrote. */
  return {
    forms: [...out].filter(Boolean), spaced: [...spacedOnly].filter(Boolean),
    letters: [...letters].filter(Boolean), plain, punct, cjk: baseCjk(text),
  };
}

/* ── the lexicon ───────────────────────────────────────────────────────────
 *
 * Every entry is a regular-expression source matched against a reading with
 * word boundaries on both sides. Lookarounds carry the exceptions, and each
 * exception is here because the plain word is ordinary English somewhere
 * this app really goes (song captions become cover prompts). */

const B = "(?![\\p{L}\\p{N}])";          // right word boundary, for lookaheads
const MUSIC_AND_TRIVIA = "(?: (?:key|keys|chord|chords|scale|scales|mode|modes|third|thirds|sixth|seventh|ninth|"
  + "progression|progressions|tonality|melody|melodies|harmony|harmonies|pentatonic|blues|feel|vibe|vibes|tone|tones|"
  + "note|notes|detail|details|role|roles|character|characters|change|changes|edit|edits|issue|issues|injury|injuries|"
  + "league|leagues|planet|planets|arcana|flaw|flaws|tweak|tweaks|adjustment|adjustments|update|updates|version|"
  + "versions|fix|fixes|point|points|part|parts|scratch|scratches|damage|variation|variations|difference|differences)" + B + ")";

const BABY_MODIFIERS = "(?: (?:blue|pink|yellow|green|powder|oil|shower|showers|doll|dolls|face|faced|shark|bump|boomer|"
  + "boomers|back|carrot|carrots|spinach|grand|steps|teeth|fat|hair|bangs|breath|lotion|wipes|food|monitor|gate|"
  + "clothes|bottle|bottles|stroller|pram|name|names|talk|fever|pictures?|photos?|"
  /* A baby ANIMAL is not a child. */
  + "elephants?|animals?|birds?|goats?|sheep|lambs?|deer|seals?|turtles?|dragons?|dinosaurs?|sharks?|whales?|"
  + "dolphins?|bears?|pandas?|tigers?|lions?|foxes|fox|owls?|chicks?|ducks?|penguins?|monkeys?|giraffes?|zebras?|"
  + "rhinos?|hippos?|hedgehogs?|bunny|bunnies|rabbits?|kittens?|puppy|puppies|octopus|alligators?|crocodiles?|"
  + "snakes?|spiders?|otters?|koalas?|sloths?|yoda|groot)" + B + ")";

const NUDE_FASHION = "(?: (?:color|colour|colors|colours|colored|coloured|tone|tones|toned|tint|shade|shades|palette|"
  + "lipstick|lipsticks|lip|lips|gloss|lipgloss|heels|heel|shoes|shoe|pumps|sandals|boots|flats|beige|pink|peach|"
  + "brown|tan|nails|nail|polish|manicure|makeup|make up|eyeshadow|blush|foundation|stockings|tights|hosiery|mesh|"
  + "fabric|silk|satin|dress|dresses|gown|gowns|skirt|skirts|top|tops|blouse|bodysuit|slip|trench|coat|blazer|"
  + "suit|knit|sweater|leather|velvet|packaging|package|packages|box|boxes|label|labels|swatch|swatches|wall|walls|"
  + "paint|background|backdrop)" + B + ")";

const NAKED_OTHER = "(?: (?:eye|eyes|truth|truths|flame|flames|lunch|ambition|aggression|bulb|bulbs|light|lights|"
  + "lightbulb|wire|wires|tree|trees|branch|branches|cake|cakes|singularity|city|gun|guns|blade|steel)" + B + ")";

/** The words right beside "baby" that make it a person with no determiner:
 *  "baby, nude" and "naked baby" are, "baby I love you, so sexy" is not. */
const NUDITY_NEAR = "(?:nude(?!" + NUDE_FASHION + ")|nudes|naked(?!" + NAKED_OTHER + ")|topless|bottomless|undressed|"
  + "unclothed|lingerie|porn|porno|nsfw|hentai|xxx|lewd)";

/** A minor, on its own. */
const MINOR = [
  "child(?:ren|s|ern|en|like)?", "chlid(?:ren)?", "chidren", "girlchild", "boychild",
  "(?<!(?:karate|billy the|goat) )kid(?:s|z|die|dies|dy|do|dos)?(?! (?:gloves?|leather|mohair|goats?|rock|cudi)" + B + ")",
  "youngsters?", "minors",
  "(?:is|was|are|were|being|as|like|with|involving|depicting|showing|of|sexy|nude|naked) (?:a |an |the )?minor(?!" + MUSIC_AND_TRIVIA + ")",
  "minor (?:girl|girls|boy|boys|child|children|kid|kids|teen|teens|female|females|male|males|model|models|person|persons|people|student|students)",
  "under ?(?:age|aged|18|eighteen)", "underaged?",
  "pre ?teens?", "pre ?teenage(?:r|rs|d)?",
  "tweens?(?! (?:animation|animations|frame|frames|keyframe|keyframes|library|engine|function|easing|curve|curves)" + B + ")",
  /* "teen pop" is a genre (half a dozen style tags); a teen pop STAR is a teenager. */
  "teens?(?! (?:spirit|titans?|wolf|choice)" + B + ")(?! pop(?! (?:star|stars|idol|idols|singer|singers|sensation|girl|girls|boy|boys))" + B + ")",
  "teen(?:age|aged|ager|agers)(?! mutant" + B + ")", "teenies?",
  "adolescen(?:t|ts|ce|te|tes)", "(?:pre ?)?pubescen(?:t|ts|ce)", "prepubertal", "puberty",
  "school ?(?:girl|girls|boy|boys|child|children|kid|kids)",
  "(?:young|little|small|tiny|lil|yung) (?:girl|girls|boy|boys|child|children|kid|kids|teen|teens|daughter|daughters|son|sons)",
  "toddlers?", "todlers?", "infants?", "newborns?", "neonates?", "babies",
  "(?<=(?:^| )(?:a|the|her|his|their|newborn|infant|little|tiny|small|naked|nude|topless|undressed|nsfw|porn|hentai|lewd) )baby(?!" + BABY_MODIFIERS + ")",
  "baby(?: girl| boy)?(?=,? " + NUDITY_NEAR + B + ")",
  "(?:her|his|their|a|the|newborn|little) baby (?:girl|boy|girls|boys)",
  "lolis?", "(?<!(?:gothic|goth|sweet|classic|punk|wa|country) )lolitas?(?! (?:fashion|dress|dresses|style|styled|clothes|clothing|outfit|outfits|coord|coords|cosplay)" + B + ")",
  "rori", "shotas?", "shouta", "juveniles?",
  /* Spanish slang "¿qué pedo?" is not the English word, so bare "pedo" needs
   * a sexual word beside it; the unambiguous forms are in BOTH. */
  "pedos?",
  "kindergart(?:en|ener|eners|ner|ners)", "pre ?school(?:er|ers)?", "nursery school", "grade ?school(?:er|ers)?",
  "elementary (?:school|schooler|schoolers|student|students|age|aged|girl|girls|boy|boys|kid|kids|child|children)",
  "middle ?school(?:er|ers)?", "junior high", "jr high", "primary school(?:er|ers)?",
  "(?:1st|2nd|3rd|[4-9]th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) grade(?:r|rs)?",
  "high ?school(?:er|ers)", "high school (?:girl|girls|boy|boys|student|students|kid|kids)", "sweet sixteen",
  // Dutch
  "kinderen", "kindjes?", "meisjes?", "jongetjes?", "minderjarig(?:e|en)?", "tieners?", "tienermeisjes?",
  "tienerjongens?", "kleuters?", "peuters?", "zuigelingen?", "schoolmeisjes?", "schooljongens?", "basisschool\\w*",
  "(?:jong|jonge|klein|kleine) (?:meisje|meisjes|jongen|jongens|kind|kinderen)",
  // German (umlauts arrive stripped, and the ae/oe/ue spellings are listed too)
  "kindern", "kindes", "madchen", "maedchen", "jugendlich(?:e|er|en|es)?", "minderjahrig(?:e|er|en|es)?",
  "minderjaehrig(?:e|er|en|es)?", "kleinkind(?:er)?", "sauglinge?", "saeuglinge?", "schulmadchen", "schulmaedchen",
  "grundschul(?:e|er|erin|erinnen|kind|kinder)", "knaben?",
  // Spanish, Portuguese, Italian, French, Polish (diacritics arrive stripped)
  /* "Nina" and "Nena" are names; the Spanish words arrive as girlchild and
   * boychild (baseLatin), and only the plurals are read without their tilde. */
  "ninos", "ninas", "chiquill(?:o|a|os|as)", "menor(?:es)? de (?:edad|idade)",
  "criancas?", "meninas?", "meninos?",
  "bambin(?:o|a|i|e)", "ragazzin(?:o|a|i|e)", "minorenn[ei]",
  "enfants?(?! terribles?" + B + ")", "fillettes?", "petites? filles?", "petits? garcons?", "garconnets?",
  "dzieck(?:o|a|iem|u)", "dzieci(?:ak\\w*)?", "dziewczyn(?:k\\w*)", "chlop(?:iec|cy|ca|czyk\\w*)", "nieletn\\w*", "nastolat\\w*",
  // Japanese, romanised
  "shou?gakusei", "chuu?gakusei", "joshi ?kou?sei", "joshi ?chuu?gakusei", "youjo", "kodomo",
];

/** Nudity or sex, on its own. */
const SEXUAL = [
  "nude(?!" + NUDE_FASHION + ")", "nudes", "noods", "nudez", "nudity", "nudists?", "nudism", "naturists?", "naturism",
  "naked(?!" + NAKED_OTHER + ")", "nakedness", "nekkid", "nakid", "nekked", "unclad",
  "topless(?! (?:car|cars|convertible|convertibles|jeep|jeeps|bus|buses|tram|trams|tower|towers|roadster)" + B + ")",
  "bottomless(?! (?:pit|pits|mimosa|mimosas|brunch|cup|cups|coffee|drink|drinks|fries|well|wells|abyss|chasm|ocean|sea|void|hole|holes|lake|bag|bags|glass)" + B + ")",
  "undress(?:ed|es|ing)?", "unclothed", "disrob(?:e|ed|es|ing)",
  "(?:no|without|wearing no|not wearing|isnt wearing|is not wearing|without any|not wearing any) (?:clothes|clothing|anything|a stitch|pants|trousers|underwear|panties)",
  "wearing nothing", "(?:wearing|has|had|with) nothing on", "clothes (?:off|removed|taken off)", "in the buff", "birthday suit", "skinny ?dipping", "skinny dip",
  "partially (?:clothed|dressed|undressed)", "half ?(?:dressed|clothed|undressed)", "scantily(?: (?:clad|dressed))?",
  "stripped (?:naked|nude|bare|off|of (?:her|his|their) clothes)",
  "strip ?teas(?:e|es|ing)", "(?<!(?:paint|wire|varnish|wallpaper|bark|floor) )strip(?:per|pers|ping)(?! (?:paint|wallpaper|wire|wires|varnish|bark)" + B + ")",
  "lingerie", "underwear", "undies", "panty", "panties", "thongs?(?! (?:sandal|sandals|flip ?flops?|slippers?)" + B + ")",
  /* French "dans mes bras" is "in my arms". */
  "gstrings?", "(?<!(?:sports|mes|tes|ses|les|des|nos|vos|leurs|dans|aux|deux|grands|gros|petits) )bras?",
  "(?:see ?through|transparent|sheer|wet) (?:dress|dresses|shirt|shirts|top|tops|clothes|clothing|lingerie|underwear|blouse|nightgown|nightie|t ?shirt|panties)",
  "erotic(?:a|ism|ally|ized|ised|o|os|as|he|hes|que|ques)?", "eroge",
  /* Japanese "ero"; Italian "ero" is "I was" ("quando ero un ragazzo"). */
  "(?<!(?:io|quando|non|ci|lo|la|gli|ne|che|se|come|dove|mentre|gia|ormai|allora|anche|solo|ne) )ero(?! (?:un|una|uno|il|lo|la|i|gli|le|in|a|da|di|con|su|per|tra|fra|solo|sola|stato|stata|piccolo|piccola|giovane|felice|bambino|bambina|ragazzo|ragazza|qui|li|ancora|sempre|mai|cosi|troppo|molto|tanto|pronto|pronta|nato|nata|sicuro|sicura|io|tu|te|con te)" + B + ")",
  "sexual(?:ly|ity|ized|ised|ize|ise|isation|ization)?(?! (?:orientation|identity)" + B + ")",
  "(?<!(?:same|opposite|biological|either|both|other|fairer|weaker|gentle|gentler|assigned) )sex(?! (?:pistols|and the city|education|ed|determination|ratio|chromosome|chromosomes|difference|differences|cell|cells|hormone|hormones|linked|specific|male|female|m|f|unknown|unspecified|neutral|and gender|or gender|assigned)" + B + ")",
  "sexy", "sexxy", "seggs", "seggsy", "secks", "sexting", "sexed up",
  "porn", "porno", "pornos", "porny", "pornographic", "pornography", "pr0n",
  "nsfw", "not safe for work", "xxx", "hentai", "ecchi", "ahegao", "oppai", "paizuri", "futanari",
  "lewd(?:ness)?", "smut(?:ty)?", "obscene", "onlyfans", "boudoir", "uncensored",
  "rating (?:explicit|questionable)", "explicit rating", "r ?18(?:g)?",
  "(?<!advisory )explicit(?:ly)? (?:sex|sexual|nudity|nude|naked|content|scene|scenes|imagery|image|images|photo|photos|pics?|material|art|depiction|pose|poses)",
  "seduc(?:e|ed|es|ing|tive|tively|tion|tress)",
  "(?:provocative|suggestive)(?:ly)? (?:pose|poses|posing|posed|outfit|outfits|clothing)",
  "horny(?! (?:toad|toads|lizard|lizards|beetle|beetles)" + B + ")", "arous(?:ed|al|ing)", "orgasm(?:s|ic)?",
  "kinky(?! (?:hair|curls|curly|coils|twist|twists|texture|boots)" + B + ")", "fetish(?:es|ism|istic)?",
  "bdsm", "bondage", "dominatrix",
  "genital(?:s|ia)?", "penis(?:es)?", "vagina(?:s|l)?", "vulva(?:s)?", "labia", "clitoris", "clit",
  "pubic(?: hair| area| region| mound)?", "private parts",
  "(?<!(?:moby|k|philip k|spotted) )dicks?(?! (?:van|tracy|grayson|whittington|turpin|smothers|cheney|clark|york|francis|dastardly|and jane)" + B + ")",
  "cocks?(?! (?:fight|fights|fighting|crow|crows|crowing|a doodle|pheasant|robin|sparrow|of the walk|tail|tails|pit|spur|spurs|ring|and bull)" + B + ")",
  "(?<!(?:kick|kicks|kicked|kicking|kickin|smart|bad|dumb|hard|lazy|jack|wise|half|big|bust|busting|haul|hauling|move|save|saved|cover|covered|kiss|kissing|pain in the|pain in my|sorry|whup|whoop) )ass(?:es)?(?! (?:kicking|kicker|kickers|backwards|backward|of|and a half)" + B + ")",
  "(?<!(?:cigarette|cig|rifle|gun|pork|boston|scuttle|water) )butts?(?! (?:of|end|ends|joint|joints|weld|welds|hinge|hinges|head|heads|kicking|kick|load|in)" + B + ")",
  "pussy(?! (?:cat|cats|willow|willows)" + B + ")", "testicles?", "scrotum", "anus",
  "anal(?! (?:retentive|gland|glands)" + B + ")", "nipples?", "areola(?:s|e)?",
  "(?<!(?:chicken|turkey|duck|poultry|grilled|roast|roasted|fried|baked|quail|goose|pheasant|boneless|skinless) )breasts",
  "boobs", "boobies", "titties", "titty", "(?<!(?:blue|great|coal|marsh|willow|crested|tailed|bearded) )tits",
  "cleavage", "buttocks", "crotch", "upskirts?", "up skirt", "downblouse", "down blouse", "cameltoe", "camel toe",
  "nip ?slips?", "spread legs", "legs spread", "legs apart", "spreading (?:her |his |their )?legs",
  "masturbat\\w*", "intercourse", "orgy", "orgies", "gang ?bangs?", "blow ?jobs?", "hand ?jobs?", "fellatio",
  "cunnilingus", "ejaculat\\w*", "cum ?shots?", "creampies?", "semen", "sperm(?! whales?" + B + ")",
  "cum(?:s|med)?(?! (?:laude|grano)" + B + ")", "(?<!alan )cumming",
  "penetrat(?:ed|ion|ions)(?! (?:test|tests|testing|tester|testers|rate|rates|depth|pricing|strategy|of|resistance)" + B + ")",
  "threesomes?", "foursomes? sex", "deep ?throat(?:ing|ed)?(?! (?:informant|watergate)" + B + ")",
  "doggy ?style", "missionary position", "(?:reverse )?cowgirl position", "reverse cowgirl", "oral sex",
  "finger(?:ing|ed|s) (?:her|him|herself|himself|themselves|pussy|vagina|clit)",
  "streakers?",
  "erections?(?! of" + B + ")",
  "(?:having|making|made) love", "fuck(?:s|ed|ing|er|ers)?",
  "rap(?:ed|ing|ist|ists)", "rapes?(?! (?:field|fields|flower|flowers|oil|plant|plants|crop|crops|seed|seeds|blossom|blossoms)" + B + ")",
  "molest\\w*", "fondl\\w*", "grop(?:e|ed|es|ing)", "incest\\w*",
  // Dutch
  "naakt(?:e|heid)?", "poedelnaakt",
  "bloot(?! (?:toeval|staan|staat|stond|stonden|gesteld|te stellen|stellen|stelt|liggen|ligt|legt|legde|leggen|te leggen|aan)" + B + ")",
  "blote(?! (?:voeten|voet|handen|hand|armen|arm|benen|been|knieen|hoofd|grond|oog|ogen)" + B + ")",
  "ontklee?d(?:e)?", "uitgekleed", "seks(?:ueel|uele|ualiteit)?", "erotisch(?:e)?", "geilheid", "ondergoed",
  "tepels?", "geslachtsde(?:el|len)", "schaamstreek", "masturberen", "neuken", "verkracht(?:ing|e)?",
  // German
  "nackt(?:e|er|es|en|heit|bild|bilder|foto|fotos)?", "entkleidet(?:e)?", "unbekleidet(?:e|en)?",
  "sexuell(?:e|er|es|en)?", "erotisch(?:e|er|es|en)?", "erotik", "pornografie", "pornographie",
  "unterwasche", "unterwaesche", "dessous", "bruste", "brueste", "brustwarzen?", "nippel", "genitalien",
  "geschlechtsteile?", "ficken", "vergewaltig\\w*", "oben ohne",
  // Spanish, Portuguese, Italian, French, Polish
  "desnud(?:o|a|os|as|ez)", "sexo", "sexuales", "lenceria", "ropa interior", "tetas", "en pelotas",
  "nua", "nuas", "roupa intima", "calcinhas?",
  "nud(?:a|i)", "(?<!(?:un|el|del|al|los|este|ese|aquel|primer|doble|nudos) )nudo(?! (?:de|en|marinero|corredizo|gordiano)" + B + ")",
  "spogliat(?:o|a|i|e)", "sessual(?:e|i)", "sesso", "biancheria intima", "mutandine", "tette",
  "nue", "nues", "toute nue", "tout nu", "toutes nues", "tous nus", "deshabille(?:e|es|s)?", "denude(?:e|es|s)?",
  "sexe", "sexuel(?:le|les|s)?", "pornographique", "seins", "sous vetements?",
  "nagosc", "nago", "nagie", "nadzy", "rozebran(?:a|e|y|i)", "bielizn\\w*", "erotyczn\\w*",
];

/** Words that already mean both halves. One is enough. */
const BOTH = [
  "p(?:a)?edophil(?:e|es|ia|iac|iacs|ic)", "paedos?", "pedobear", "pthc", "csam",
  "childporn", "kidporn", "kiddie ?porn", "kiddy ?porn", "child ?pornography",
  "jailbait", "lolicon", "rorikon", "shotacon", "shotakon", "nymphets?", "abdl", "ageplay",
  "(?<!(?:of|middle|ice|stone|bronze|iron|golden|space|dark|new|old|information|jazz|digital|atomic|gilded|machine|silver|modern|early|mixed|same|any|every|all|school|elizabethan|victorian|edwardian|this|that|an) )age play(?:ing|er|ers)?(?! (?:area|areas|poster|posters|theatre|theater|stage|script|scripts|production|productions)" + B + ")",
];

/* Compound tokens with no separators at all ("#nudeteen"). Only long tokens
 * are searched inside, and only for words that rarely hide in other words. */
const MINOR_INSIDE = /children|teenage|toddler|underage|preteen|schoolgirl|schoolboy|kiddie|loli(?!pop)|shota|(?<!s)child|(?<!(?:can|fif|six|seven|eigh|nine|thir|four|velve|sa|po|ump|s))teen/u;
const SEXUAL_INSIDE = /naked|nudity|(?<!de)nude|topless|lingerie|erotic|porn|hentai|nsfw|sexy|boobs|blowjob|handjob|masturbat/u;
const BOTH_INSIDE = /lolicon|shotacon|jailbait|pedophil|paedophil|childporn|kidporn|pthc/u;

/* Two whole words glued into one token ("kidnude", "#kidsnaked", "NudeKid",
 * "babynude"). The token is split at every point and BOTH halves must be
 * whole words below, so "kidnapper" (kid + napper) and "Sussex" are not. */
const GLUE_MINOR = ["kid", "kids", "kiddie", "kiddies", "kiddo", "child", "children", "childs", "teen", "teens",
  "teenage", "teenager", "preteen", "toddler", "toddlers", "infant", "loli", "lolis", "shota", "schoolgirl",
  "schoolboy", "underage", "minor", "minors", "youngteen", "girlchild", "boychild"];
const GLUE_BABY = ["baby", "babies"];
const GLUE_SEXUAL = ["nude", "nudes", "naked", "nudity", "sexy", "sex", "porn", "porno", "nsfw", "lingerie",
  "topless", "hentai", "boobs", "pussy", "xxx", "lewd", "erotic", "undressed", "panties", "nipples"];
const GLUE_NUDITY = ["nude", "nudes", "naked", "nudity", "topless", "nsfw", "porn", "porno", "hentai", "xxx",
  "lingerie", "undressed"];
const GS = { minor: new Set(GLUE_MINOR), baby: new Set(GLUE_BABY), sexual: new Set(GLUE_SEXUAL), nudity: new Set(GLUE_NUDITY) };

function glued(tok) {
  if (tok.length < 5 || tok.length > 40 || !/^\p{L}+$/u.test(tok)) return false;
  for (let i = 3; i <= tok.length - 3; i++) {
    const a = tok.slice(0, i), b = tok.slice(i);
    if ((GS.minor.has(a) && GS.sexual.has(b)) || (GS.sexual.has(a) && GS.minor.has(b))) return true;
    if ((GS.baby.has(a) && GS.nudity.has(b)) || (GS.nudity.has(a) && GS.baby.has(b))) return true;
  }
  return false;
}

/* The key words with any letter doubled or tripled ("chilld", "nudde",
 * "kiid"). Only a spelling that is NOT the word itself counts here: the word
 * itself is judged by the lexicon above, with its exceptions ("kid gloves"). */
const TYPO_MINOR = ["child", "children", "kid", "kids", "kiddie", "toddler", "teen", "teens", "teenager", "preteen",
  "minors", "infant", "loli", "schoolgirl", "underage"];
const TYPO_SEXUAL = ["nude", "nudes", "nudity", "naked", "porn", "porno", "sexy", "lingerie", "topless", "nsfw",
  "hentai", "boobs", "penis", "vagina", "nipples", "erotic", "undressed"];
const typoRe = (words) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...words].sort((a, b) => b.length - a.length)
  .map((w) => [...w].map((c) => `${c}+`).join("")).join("|")})(?![\\p{L}\\p{N}])`, "gu");
const TYPO = { minor: typoRe(TYPO_MINOR), sexual: typoRe(TYPO_SEXUAL), minorSet: new Set(TYPO_MINOR), sexualSet: new Set(TYPO_SEXUAL) };
function typoHit(form, re, canon) {
  re.lastIndex = 0;
  for (const m of form.matchAll(re)) if (!canon.has(m[0])) return true;
  return false;
}

/* CJK, matched inside the text: these scripts do not put spaces between
 * words. "ロリ" must not match inside "カロリー" (calorie), hence the lookbehind;
 * 裸 is not 裸足 (barefoot), 裸眼 (naked eye) or 赤裸々 (candid); 性的 after
 * another Han character is 個性的 (individual) or 女性的 (feminine); 下着雨 is
 * Chinese for "it is raining". */
const KATA = "\\u30A0-\\u30FF";
const MINOR_CJK = new RegExp(`子供|子ども|こども|幼女|幼児|児童|小学生|中学生|女子高生|未成年|赤ちゃん|乳児|幼稚園児|園児|女児|男児|`
  + `儿童|幼儿|小孩|小女孩|小男孩|女童|男童|初中生|高中生|孩子|孩童|小朋友|宝宝|婴儿|少女|少年|萝莉|正太|`
  + `(?<![${KATA}])ロリ|(?<![${KATA}])ショタ`, "u");
const SEXUAL_CJK = new RegExp(`(?<!赤)裸(?![足眼々]|子植物)|ヌード|(?<![${KATA}])エロ(?!イカ)|セックス|性交|性行為|(?<!\\p{Script=Han})性的|`
  + `乳首|性器|陰部|阴部|阴道|阴茎|生殖器|猥褻|わいせつ|痴漢|色情|情色|做爱|性爱|性感|淫|脱衣|下着(?![雨雪棋])|内衣|乳房|私处|`
  + `色图|涩图|黄图|おっぱい`, "u");
const BOTH_CJK = /ロリコン|ショタコン|児童ポルノ|萝莉控|恋童|儿童色情/u;
/* Korean joins particles to words, so these are matched inside too. 소녀시대
 * (Girls' Generation) is a band of adults; 유아인 is an actor's name. */
const MINOR_KO = /어린이|어린아이|소녀(?!시대)|소년|여아|아동|유아(?!인|독존)|미성년|초등학생|중학생|여중생|고등학생|여고생|로리/u;
const SEXUAL_KO = /누드|알몸|나체|섹스|야한|음란|포르노|성적(?:인|으로)|속옷|벗은 ?몸/u;
const MINOR_CYR = /(?<!\p{L})(?:реб[её]н(?:ок|ка|ку|ком)|дет(?:и|ей|ям|ьми|ях|ский|ская|ское|ские|ского)|девоч(?:ка|ки|ку|кой|ек|кам)|мальчик(?:а|и|ов|у|ом)?|школьни(?:ца|цы|цу|цей|к|ки|ков|ка)|подрост(?:ок|ка|ки|ков|ковый)|несовершеннолетн\p{L}*|малолетн\p{L}*|лоли)(?!\p{L})/u;
const SEXUAL_CYR = /(?<!\p{L})(?:гол(?:ый|ая|ое|ые|ого|ую|ыми|ышом)|обнаж[её]нн\p{L}*|наг(?:ой|ая|ие|ишом)|секс\p{L}*|порн\p{L}*|эроти\p{L}*)(?!\p{L})/u;

/* Emoji that stand for a child, and for sex. The tongue is left out on
 * purpose: a child sticking out their tongue is ordinary. */
const MINOR_EMOJI = /[\u{1F476}\u{1F9D2}\u{1F467}\u{1F466}\u{1F37C}\u{1F392}\u{1F6B8}]/u;
const SEXUAL_EMOJI = /[\u{1F346}\u{1F351}\u{1F4A6}\u{1F51E}]/u;

const bounded = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "u");
const whole = (list) => new RegExp(`^(?:${list.join("|")})$`, "u");

const RE = {
  minor: bounded(MINOR), sexual: bounded(SEXUAL), both: bounded(BOTH),
  minorWhole: whole(MINOR), sexualWhole: whole(SEXUAL), bothWhole: whole(BOTH),
};

/* Dutch/German "kind" and "kinder" are the English "kind" and "kinder" too
 * ("the kind of", "a kinder world"). They count only in Dutch or German. */
const NLDE_DETERMINED = /(?<![\p{L}\p{N}])(?:een|het|dit|dat|mijn|jouw|zijn|haar|ons|onze|hun|jong|jonge|klein|kleine|ein|das|dem|des|mein|meine|dein|sein|ihr|unser|kein|jedes|kleines|junges|die|der|den) (?:kind|kinder)(?![\p{L}\p{N}])/u;
const NLDE_MARKER = /(?<![\p{L}\p{N}])(?:een|het|niet|zonder|und|ein|eine|einem|einer|einen|nicht|ohne|ist|das|naakt\w*|nackt\w*|meisje|meisjes|madchen|maedchen|bloot|blote|seks\w*|sexuell\w*|erotisch\w*|geil\w*|ondergoed|unterwasche|unterwaesche|dessous|unbekleidet\w*|entkleidet\w*|ontklee?d\w*|uitgekleed|poedelnaakt|tepels?|geschlechtsde\w*|brustwarzen?|genitalien|geschlechtsteile?|ficken|neuken|vergewaltig\w*|verkracht\w*|jongetje\w*|minderjarig\w*|minderjahrig\w*|minderjaehrig\w*|jugendlich\w*|kinderen|kindern|tiener\w*)(?![\p{L}\p{N}])/u;
const KIND = /(?<![\p{L}\p{N}])(?:kind|kinder)(?![\p{L}\p{N}])/u;

/* ── ages ──────────────────────────────────────────────────────────────── */

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10,
  elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17,
  ein: 1, eins: 1, zwei: 2, drei: 3, funf: 5, fuenf: 5, sechs: 6, sieben: 7, neun: 9, zehn: 10,
  zwolf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, funfzehn: 15, fuenfzehn: 15, sechzehn: 16, siebzehn: 17,
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;
/** The age of a THING: "a 12 year old scotch" is a whisky, not a child. */
const AGED_THING = "(?! (?:whisky|whiskey|whiskies|scotch|bourbon|rum|cognac|brandy|wine|wines|port|sherry|tawny|"
  + "armagnac|tequila|mezcal|malt|single malt|cheese|cheddar|gouda|parmesan|vintage|barrel|cask|bottle|bottles|car|cars|"
  + "truck|house|home|building|tree|trees|oak|guitar|violin|piano|dog|dogs|cat|cats|horse|horses|laptop|phone|computer|"
  + "bike|boat|rug|carpet|photo|photos|photograph|recording|record|song|album|video|film|movie|tradition|company|"
  + "brand|business|restaurant|bar|pub|castle|church|bridge|painting)" + B + ")";
/** Words before "N years" that make it a span of time, not an age. */
const DURATION_BEFORE = "(?<!(?:for|in|after|over|within|last|past|next|than|about|around|almost|nearly|of|every|each|"
  + "per|since|spent|spend|took|take|takes|lasted|lasting|married|together|dating|known|waited|worked|lived|served|"
  + "ago|the|these|those|some|many|few|first|another|plus|at least|at most|up to|by|and|been|like|feels like) )";
/* No "model" here: "a Tesla Model 3." is a car. */
const PERSON = "(?:girl|girls|boy|boys|kid|kids|child|children|daughter|daughters|son|sons|niece|nephew|schoolgirl|"
  + "schoolboy|student|students|pupil|pupils|meisje|jongen|madchen|maedchen|junge)";
const AGE_PATTERNS = [
  new RegExp(`(?<![\\p{L}\\p{N}])${NUM} ?(?:years? old|year old|yrs? old|yr old|years? of age|yo|y o|jaar oud|jarige?n?|jahre alt|jahrige?[nrs]?|jaehrige?[nrs]?|sai)${AGED_THING}(?![\\p{L}\\p{N}])`, "gu"),
  /* Glued to a word: "girl12yo"; glued to its unit: "10yrs". */
  new RegExp(`(?<=\\p{L})(\\d{1,2})(?:yo|yrs|yr)(?![\\p{L}\\p{N}])`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:yrs|yr)(?! (?:later|ago|experience|exp|of|in|warranty|guarantee|since|after|before)${B})(?![\\p{L}\\p{N}])`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])(?:age|aged|ages|leeftijd|alter|im alter von|age of|aged of) ${NUM}(?![\\p{L}\\p{N}])`, "gu"),
  /* A person word, then the number of years: "girl, 12 years". */
  new RegExp(`(?<![\\p{L}\\p{N}])${"(?:girl|girls|boy|boys|kid|kids|child|daughter|son|niece|nephew|schoolgirl|schoolboy|pupil)"} ${NUM} ?(?:years?|yrs?|yr)(?![\\p{L}\\p{N}])`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])(?:age|aged)(\\d{1,2})(?![\\p{L}\\p{N}])`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th)? birthday(?![\\p{L}\\p{N}])`, "gu"),
  /* School years used as an age. "grade 5 titanium" is a metal. */
  new RegExp(`(?<![\\p{L}\\p{N}])grade (\\d{1,2})(?! (?:titanium|steel|bolt|bolts|alloy|aluminum|aluminium|wood|lumber|paper|leather|oil|plastic|diamond|gold|silver|concrete|fuel|bond|bonds|pencil|pencils|hardwood|marble|granite|glass|copper|brass|cotton|beef|wool|chrome|carbon|hurricane|storm|listed|piano|violin|guitar|flute|cello|singing|theory|exam|exams|music)${B})(?![\\p{L}\\p{N}])`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])(?:year|groep|klas|klasse) (\\d{1,2}) ${PERSON}(?![\\p{L}\\p{N}])`, "gu"),
];
/** Always a child, whatever the number: "6 months old", "3 weken oud". */
const INFANT_AGE = new RegExp(`(?<![\\p{L}\\p{N}])${NUM} ?(?:months?|mos?|weeks?|wks?|days?|maanden|weken|dagen|monate|wochen|tage) ?(?:old|oud|alt)(?![\\p{L}\\p{N}])`, "u");
/* Read with the punctuation kept: "girl, 12," and "12 years." are ages;
 * "12 years later" and "for 12 years" are not. */
const PUNCT_AGES = [
  new RegExp(`${DURATION_BEFORE}(?<![\\p{L}\\p{N}])${NUM}[- ]?(?:years?|yrs?|yr)(?= ?(?:[,.;:)(\\]!?]|$| ${PERSON}(?![\\p{L}\\p{N}])))`, "gu"),
  /* "girl, 12" and "girl (12)": the comma or bracket says it is her age. */
  new RegExp(`(?<![\\p{L}\\p{N}])${PERSON}(?:[,:] ?[(\\[]?| ?[(\\[])(\\d{1,2})[)\\]]?(?![\\p{L}\\p{N}])`, "gu"),
  /* "girl 12" with nothing between only at the end of a clause. */
  new RegExp(`(?<![\\p{L}\\p{N}])${PERSON} (\\d{1,2})(?= ?(?:[,.;:)!?]|$))`, "gu"),
];
const AGE_CJK = /(\d{1,3})\s*(?:歳|才|岁|살|세(?![대기]))/gu;
/* "18+" is an adults-only label; "18+ months" is a toy's age range. */
const ADULTS_ONLY = /(?<![\p{L}\p{N}])18 ?\+(?!\p{N})(?! ?(?:months?|mos?|mo|m)(?![\p{L}\p{N}]))/u;

function statedMinorAge(plain, punct, cjk) {
  const under = (raw, min = 0) => {
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    return Number.isFinite(n) && n >= min && n < 18;
  };
  for (const re of AGE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) if (under(m[1])) return true;
  }
  if (INFANT_AGE.test(plain)) return true;
  /* "Girl 1" and "boy 2" are how a cast list numbers people, so a bare number
   * after a person word counts from 3. */
  for (const [i, re] of PUNCT_AGES.entries()) {
    re.lastIndex = 0;
    for (const m of punct.matchAll(re)) if (under(m[1], i >= 1 ? 3 : 0)) return true;
  }
  AGE_CJK.lastIndex = 0;
  for (const m of cjk.matchAll(AGE_CJK)) if (under(m[1])) return true;
  return false;
}

/* ── one text ──────────────────────────────────────────────────────────── */

const NEG_WORD = "(?:no|not|without|zero|non|never|avoid|avoiding|exclude|excluding|dont|do not|does not|free of|anything but)";
const NEG_VERB = "(?: (?:depict|depicting|show|showing|include|including|draw|render|use|add|involve|involving|feature|portray|contain|containing|any|a|an|the|visible))*";
const NEGATED_MINOR = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NEG_WORD}${NEG_VERB} (?:child|children|kid|kids|minor|minors|teen|teens|teenager|teenagers|underage|toddler|toddlers|baby|babies|infant|infants|young girls?|little girls?|schoolgirls?)|(?:no one|nobody|noone|none|nothing) under ?(?:18|eighteen|age))(?![\\p{L}\\p{N}])`, "u");
const NEGATED_SEXUAL = new RegExp(`(?<![\\p{L}\\p{N}])${NEG_WORD}${NEG_VERB} (?:nudity|nude|nudes|naked|nakedness|sexual|sexually|sex|sexy|nsfw|lingerie|porn|explicit|erotic|erotica|lewd)(?![\\p{L}\\p{N}])`, "u");

/** Spelled-out letters ("n u d e") joined back into words. */
function spelledRuns(form) {
  const runs = [];
  let cur = [];
  for (const t of form.split(" ")) {
    if (t.length === 1) cur.push(t);
    else { if (cur.length >= 3) runs.push(cur.join("")); cur = []; }
  }
  if (cur.length >= 3) runs.push(cur.join(""));
  return runs;
}

/** What a joined run of single letters spells: one word, or two words run
 *  together ("k i d n u d e"), allowing one stray letter at either end
 *  ("a n u d e"). Only WHOLE words count, so "Z E B R A" is not "bra" and
 *  "H E R O" is not "ero"; and "x x x" is kisses, not a rating. */
function runSignals(run) {
  const s = { minor: false, sexual: false, both: false };
  if (/^x+$/.test(run)) return s;
  /* A run that is mostly letters with a digit or two in it ("n u d 3") is read
   * as leetspeak too; a run of numbers (a sigma schedule) never is. */
  const digits = (run.match(/\p{N}/gu) || []).length;
  if (digits && run.length - digits >= 3 && digits <= run.length / 3) {
    const r = runSignals(leet(run, LEET_I));
    s.minor ||= r.minor; s.sexual ||= r.sexual; s.both ||= r.both;
  }
  /* The only stray letter allowed is an English one-letter word in front
   * ("a n u d e"): any other would turn "H E R O" and "Z E R O" into "ero". */
  const cands = new Set([run, ...(/^[ai]/.test(run) ? [run.slice(1)] : [])].filter((c) => c.length >= 3));
  const is = (w, k) => (k === "minor" ? RE.minorWhole : k === "sexual" ? RE.sexualWhole : RE.bothWhole).test(w)
    || (k === "minor" && (GS.minor.has(w) || GS.baby.has(w))) || (k === "sexual" && GS.sexual.has(w));
  for (const c of cands) {
    for (const k of ["minor", "sexual", "both"]) if (!s[k] && is(c, k)) s[k] = true;
    for (let i = 3; i <= c.length - 3; i++) {
      const a = c.slice(0, i), b = c.slice(i);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (is(x, "minor") && is(y, "sexual")) { s.minor = true; s.sexual = true; }
      }
    }
  }
  return s;
}

/** A compound token holds a word only when it holds MORE than the word:
 *  "topless" on its own is judged by the bounded lexicon, with its exceptions
 *  ("topless jeep"); "toddlernaked" is two words run together. */
function compoundHolds(tok, re) {
  const m = re.exec(tok);
  return !!m && m[0].length < tok.length;
}

/** Compound tokens with no separators at all are searched inside only when
 *  they are this long, so ordinary words are only ever read whole. */
const COMPOUND_MIN = 7;

function signalsFromReadings({ forms, spaced = forms, letters = forms, plain, punct = plain, cjk }, nlde) {
  const s = { minor: false, sexual: false, both: false, negatedMinor: false, negatedSexual: false };
  for (const f of forms) {
    if (!s.both && RE.both.test(f)) s.both = true;
    if (!s.minor && RE.minor.test(f)) s.minor = true;
    if (!s.sexual && RE.sexual.test(f)) s.sexual = true;
    if (!s.minor && KIND.test(f) && (nlde || NLDE_DETERMINED.test(f))) s.minor = true;
    if (!s.minor && typoHit(f, TYPO.minor, TYPO.minorSet)) s.minor = true;
    if (!s.sexual && typoHit(f, TYPO.sexual, TYPO.sexualSet)) s.sexual = true;
    if (!s.negatedMinor && NEGATED_MINOR.test(f)) s.negatedMinor = true;
    if (!s.negatedSexual && NEGATED_SEXUAL.test(f)) s.negatedSexual = true;
    for (const run of letters.includes(f) ? spelledRuns(f) : []) {
      const r = runSignals(run);
      s.minor ||= r.minor; s.sexual ||= r.sexual; s.both ||= r.both;
    }
  }
  for (const f of spaced) {
    for (const tok of f.split(" ")) {
      if (tok.length >= 5 && !(s.minor && s.sexual) && glued(tok)) { s.minor = true; s.sexual = true; }
      if (tok.length < COMPOUND_MIN) continue;
      if (!s.both && compoundHolds(tok, BOTH_INSIDE)) s.both = true;
      if (!s.minor && compoundHolds(tok, MINOR_INSIDE)) s.minor = true;
      if (!s.sexual && compoundHolds(tok, SEXUAL_INSIDE)) s.sexual = true;
    }
  }
  if (!s.minor && statedMinorAge(plain, punct, cjk)) s.minor = true;
  if (!s.sexual && ADULTS_ONLY.test(punct)) s.sexual = true;
  if (!s.minor && (MINOR_CJK.test(cjk) || MINOR_KO.test(cjk) || MINOR_CYR.test(cjk) || MINOR_EMOJI.test(cjk))) s.minor = true;
  if (!s.sexual && (SEXUAL_CJK.test(cjk) || SEXUAL_KO.test(cjk) || SEXUAL_CYR.test(cjk) || SEXUAL_EMOJI.test(cjk))) s.sexual = true;
  if (!s.both && BOTH_CJK.test(cjk)) s.both = true;
  return s;
}

/**
 * The signals in one text, as booleans only: nothing that matched is kept, so
 * no caller can end up logging the words. `dutchOrGerman` lets a caller say
 * the text sits beside Dutch or German words in another field.
 */
export function signalsOf(text, { dutchOrGerman = null } = {}) {
  const r = readings(text);
  return signalsFromReadings(r, dutchOrGerman ?? r.forms.some((f) => NLDE_MARKER.test(f)));
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
  .flat(Infinity)
  .filter((x) => typeof x === "string" && x.trim());

/** Wordless flags a caller carries instead of words: the fingerprint stored on
 *  a picture, a clip or an MV take when it was made (fingerprintOf), or the
 *  flags a friend's order carries for each of its pictures. Anything that is
 *  not an object is ignored; a flag can only ADD a half, never remove one. */
const asFlags = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
  .flat(Infinity)
  .filter((x) => x && typeof x === "object");

function combined(texts, context, flags) {
  const own = asList(texts).map(readings);
  const ctx = asList(context).map(readings);
  const nlde = [...own, ...ctx].some((r) => r.forms.some((f) => NLDE_MARKER.test(f)));
  const fold = (list) => {
    const s = { minor: false, sexual: false, both: false, negatedMinor: false, negatedSexual: false };
    for (const r of list) {
      const x = signalsFromReadings(r, nlde);
      for (const k of Object.keys(s)) s[k] ||= x[k];
    }
    return s;
  };
  const a = fold(own), b = fold(ctx);
  for (const f of asFlags(flags)) {
    b.minor ||= f.minor === true || f.both === true;
    b.sexual ||= f.sexual === true || f.both === true;
    b.both ||= f.both === true;
  }
  return { own: a, ctx: b, any: own.length + ctx.length + asFlags(flags).length > 0 };
}

/**
 * THE CHECK.
 *
 * @param {string|string[]} texts  the POSITIVE-intent text that will be
 *   rendered: the prompt after every wildcard, persona and template has been
 *   applied. Never the negative prompt.
 * @param {object} [opts]
 * @param {string|string[]} [opts.context]  text the model will not read but
 *   whose subject reaches it another way: the stored prompt of a reference
 *   picture, an MV cast member's description behind a <Picture n>. It counts
 *   on both sides, exactly like the prompt.
 * @param {object|object[]} [opts.flags]  wordless {minor, sexual} flags carried
 *   by a picture or clip the request uses (fingerprintOf). They count like
 *   context.
 * @returns {{ok:true} | {ok:false, reason:string, code:string, hint?:string,
 *   found:{minor:string[], sexual:string[]}}}
 *   There is no third answer and no option that turns the check off. `found`
 *   names WHERE each half came from ("prompt" or "context"), never what.
 */
export function checkPrompt(texts, { context = [], flags = [] } = {}) {
  const { own, ctx, any } = combined(texts, context, flags);
  if (!any) return { ok: true };
  const minor = own.minor || ctx.minor, sexual = own.sexual || ctx.sexual, both = own.both || ctx.both;
  if (!(both || (minor && sexual))) return { ok: true };
  const where = (k) => [...(own[k] || own.both ? ["prompt"] : []), ...(ctx[k] || ctx.both ? ["context"] : [])];
  const found = { minor: where("minor"), sexual: where("sexual") };
  /* When the words typed here would pass on their own, say that the rest came
   * from something the request uses. Which picture or cast member is for the
   * caller to name; this file never keeps words. */
  const fromContext = !(own.both || (own.minor && own.sexual));
  const hints = [
    ...(own.negatedMinor || own.negatedSexual ? [NEGATION_HINT] : []),
    ...(fromContext ? [CONTEXT_HINT] : []),
  ];
  return { ok: false, reason: REFUSAL, code: CODE, found, ...(hints.length ? { hint: hints.join(" ") } : {}) };
}

/**
 * THE WORDLESS FINGERPRINT kept on what this app makes: two booleans, never
 * the words. Stored on a picture's or clip's meta and on an MV take at render
 * time (private renders too, which keep no prompt), copied forward onto
 * everything derived from it, and read back through `flags` so that "make her
 * nude" on a picture made as a child is refused however many edits, sheets or
 * composites stand between them, and however the words were changed since.
 */
export function fingerprintOf(texts, { context = [], flags = [] } = {}) {
  const { own, ctx } = combined(texts, context, flags);
  return {
    minor: own.minor || ctx.minor || own.both || ctx.both,
    sexual: own.sexual || ctx.sexual || own.both || ctx.both,
  };
}

/** OR several fingerprints together (undefined and junk are ignored). */
export function mergeFingerprints(...list) {
  const out = { minor: false, sexual: false };
  for (const f of asFlags(list)) { out.minor ||= f.minor === true; out.sexual ||= f.sexual === true; }
  return out;
}
