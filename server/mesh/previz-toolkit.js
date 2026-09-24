/**
 * Where the GPL Blender toolkit keeps the out-of-tree bpy scripts, and how to
 * point Studio at them: the one wording every 503 for a missing script uses
 * (avatar-weight-transfer.js, avatar-fitting.js).
 *
 * weight_transfer.py and attachment_fit.py import bpy, so this Apache-2.0 tree
 * ships no copy of either (server/licence_test.js). The toolkit repository
 * carries both, with their suites, in its previz/ folder. The resolvers stay
 * config.js's; this file only explains their outcome, and offers only a remedy
 * that would change it: a set variable wins over everything
 * (outsideTreeScript), and with none set a script is looked for beside the
 * toolkit cli.py that config.blender.previz names, which defaults to
 * vendor/previz-blender/previz/cli.py in the Studio folder.
 */
import path from 'node:path';
import {config} from '../config.js';

export const PREVIZ_TOOLKIT_REPO='https://github.com/Senzube4n/AIPLAY-previz-blender';

/**
 * Whether anyone can open PREVIZ_TOOLKIT_REPO. It was PRIVATE on 2026-09-24
 * (`gh repo view Senzube4n/AIPLAY-previz-blender --json visibility`), so the
 * sentence says the link opens only for people it was shared with, instead of
 * sending a newcomer to a 404 as if it were published. Making the repository
 * public is the owner's call; flip this in the change that follows it, and
 * the tests hold the sentence and docs/AVATAR_PARTS.md to the new state.
 */
export const PREVIZ_TOOLKIT_PUBLIC=false;

/**
 * The "where it lives, how to point Studio at it" half of a missing-script
 * sentence. `variables` are the environment variables config.js consults for
 * this script, in its order: the script's own first, then one it follows
 * (unset, attachment_fit.py is looked for beside weight_transfer.py). The
 * first one set decided the path, so it is the one to fix; a clone or
 * AIPLAY_PREVIZ is offered only when none is set, because only then would
 * either be read.
 */
export function toolkitScriptHelp(file,variables,{published=PREVIZ_TOOLKIT_PUBLIC}={}){
  const [own]=variables,env=process.env,decided=variables.find(v=>env[v]);
  const where=published
    ?`The GPL Blender toolkit publishes it as previz/${file} at ${PREVIZ_TOOLKIT_REPO}. `
    :`The GPL Blender toolkit keeps it as previz/${file} in ${PREVIZ_TOOLKIT_REPO}, but that repository is not public yet: until it is, the link opens only for people it has been shared with. `;
  const end=' Nothing is downloaded automatically.';
  if(decided===own)return where
    +`${own} names that path, and a set variable wins over any toolkit clone: point it at a copy of the toolkit's previz/${file}, or unset it, then restart Studio.`+end;
  if(decided)return where
    +`With ${own} unset, ${file} is looked for beside the file ${decided} names (${env[decided]}), and a set variable wins over any toolkit clone: `
    +`point ${decided} at the same script in a copy of the toolkit's previz/ folder, where the scripts sit together, or unset it, or set ${own} to ${file} itself, then restart Studio.`+end;
  const previz=config.blender.previz,clone=path.dirname(path.dirname(previz));
  return where
    +`Clone that repository to ${clone} (from a ZIP, unpack it so that ${path.relative(clone,previz)} sits directly in that folder), `
    +`or set AIPLAY_PREVIZ to the previz/cli.py of a clone elsewhere, or set ${own} to the script itself, then restart Studio.`+end;
}
