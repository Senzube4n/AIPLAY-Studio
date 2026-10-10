/** Named asset reference packs. Pure: legacy imageFile remains the default. */
export const REFERENCE_ROLES = ["identity", "body", "side", "outfit", "style", "detail"];
export const REFERENCE_PACK_CAP = 6;
const IMAGE = /^[^\\/\u0000-\u001f]+\.(png|jpe?g|webp)$/i;
const record = (v) => v && typeof v === "object" && !Array.isArray(v);

export function readReferenceRole(value = "identity") {
  if (!REFERENCE_ROLES.includes(value)) throw new Error(`reference role must be ${REFERENCE_ROLES.join(" | ")}`);
  return value;
}

/** Files are project-local basenames, never arbitrary paths. */
export function readReferenceImages(value) {
  if (!Array.isArray(value) || value.length > REFERENCE_PACK_CAP) {
    throw new Error(`referenceImages must contain at most ${REFERENCE_PACK_CAP} images`);
  }
  const roles = new Set(), files = new Set();
  return value.map((r) => {
    if (!record(r) || typeof r.file !== "string" || !IMAGE.test(r.file) || r.file.includes("..")) {
      throw new Error("A reference image must be a PNG, JPEG or WebP filename in this project's assets");
    }
    const role = readReferenceRole(r.role);
    if (roles.has(role) || files.has(r.file)) throw new Error("Use one image per reference role and one role per image");
    roles.add(role); files.add(r.file);
    return { role, file: r.file };
  });
}

/** No eager migration: changing the adopted image still changes legacy identity. */
export function assetReferenceImages(row) {
  const pack = Array.isArray(row?.referenceImages) ? row.referenceImages : [];
  const images = pack.filter((r) => record(r) && REFERENCE_ROLES.includes(r.role) && typeof r.file === "string" && IMAGE.test(r.file) && !r.file.includes(".."));
  if (row?.imageFile && !images.some((r) => r.role === "identity" || r.file === row.imageFile)) {
    images.unshift({ role: "identity", file: row.imageFile });
  }
  const seen = new Set();
  return images.sort((a, b) => REFERENCE_ROLES.indexOf(a.role) - REFERENCE_ROLES.indexOf(b.role))
    .filter((r) => !seen.has(r.file) && seen.add(r.file)).slice(0, REFERENCE_PACK_CAP);
}

/** One named asset gets one set of Picture slots, even on older repeated lists. */
export function namedReferences(board) {
  const seen = new Set();
  return ["characterRefs", "backgroundRefs", "propRefs"].flatMap((declaredAs) =>
    (board?.[declaredAs] || []).filter((name) => !seen.has(name) && seen.add(name))
      .map((name) => ({ name, declaredAs })));
}

/** Explicit selection is validated against referenced names and available roles. */
export function readRefRoles(value, doc, names) {
  if (!record(value)) throw new Error("refRoles must be an object of asset names and reference role arrays");
  const rows = [...(doc.characters || []), ...(doc.backgrounds || []), ...(doc.props || [])];
  const out = Object.create(null);
  for (const [name, roles] of Object.entries(value)) {
    const row = rows.find((r) => r.name === name);
    if (!row || !names.includes(name)) throw new Error(`refRoles names "${name}", which is not referenced on this scene`);
    if (!Array.isArray(roles) || !roles.length || roles.length > REFERENCE_PACK_CAP) {
      throw new Error(`refRoles for "${name}" must select 1-${REFERENCE_PACK_CAP} roles`);
    }
    const available = new Set(assetReferenceImages(row).map((r) => r.role));
    out[name] = [...new Set(roles.map(readReferenceRole))];
    for (const role of out[name]) if (!available.has(role)) throw new Error(`"${name}" has no ${role} reference image`);
  }
  return out;
}

export function selectedReferenceImages(row, roles) {
  const images = assetReferenceImages(row);
  return images.filter((r) => Array.isArray(roles) ? roles.includes(r.role) : r.role === (images.find((x) => x.role === "identity")?.role || images[0]?.role));
}

export const referenceLabel = (name, role) => role && role !== "identity" ? `${name} (${role} reference)` : name;
