/** Keep the selected bytes and their attribution together across file encoding. */
export async function prepareAvatarImport(form, encodeFile) {
  const file = form.elements.file.files[0];
  const profile = form.elements.profile.value;
  const limit = profile === 'vrm' ? 64 : 8;
  if (!file || file.size > limit * 1024 * 1024) {
    throw Error(`Choose an avatar up to ${limit} MiB.`);
  }
  const body = { action: 'import', profile };
  for (const name of ['name', 'persona_id', 'facing', 'skeleton_family', 'source', 'license']) {
    body[name] = form.elements[name].value;
  }
  body.data_base64 = await encodeFile(file);
  return body;
}
