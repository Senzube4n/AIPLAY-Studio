import * as THREE from 'three';
import { VRMLoaderPlugin, VRMExpressionMaterialColorBind } from '/api/avatars/vendor/three-vrm.module.js';

/** Keep embedded raw-bone clips authoritative until the user selects the pose test. */
export const createAvatarLoaderPlugin = parser => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false });

const materialList = object => Array.isArray(object.material) ? object.material : [object.material];
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const indexKey = value => /^(0|[1-9][0-9]*)$/.test(String(value));

const disposedScenes = new WeakSet();
/** The viewer owns one independent GLTF load, including decoded image bitmaps. */
export function disposeAvatarScene(root) {
  if (!root || disposedScenes.has(root)) return;
  disposedScenes.add(root);
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set(), images = new Set();
  const remember = value => {
    for (const texture of Array.isArray(value) ? value : [value]) if (texture?.isTexture) {
      textures.add(texture);
      if (typeof texture.source?.data?.close === 'function') images.add(texture.source.data);
    }
  };
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    for (const material of materialList(object)) if (material) {
      materials.add(material);
      for (const value of Object.values(material)) remember(value);
      // MToon's texture getters are non-enumerable; sampler storage is here.
      for (const uniform of Object.values(material.uniforms || {})) remember(uniform.value);
    }
  });
  for (const value of skeletons) value.dispose();
  for (const value of geometries) value.dispose();
  for (const value of materials) value.dispose();
  for (const value of textures) value.dispose();
  for (const value of images) value.close();
}

/**
 * Presentation on the original loaded objects, with no mesh rebinding or file changes.
 * Call update AFTER an embedded clip's mixer. The viewer owns resource disposal.
 * RGBA overrides use glTF's linear color space, not CSS/sRGB values.
 */
export function createAvatarRuntime(gltf) {
  const scene = gltf.scene;
  if (!scene?.traverse) throw new TypeError('A loaded glTF scene is required.');
  const associations = gltf.parser?.associations;
  const json = gltf.parser?.json || {};
  const vrm = gltf.userData?.vrm || null;
  const humanoid = vrm?.humanoid;
  const expressions = vrm?.expressionManager;
  const springs = vrm?.springBoneManager;
  const originalAutoUpdate = humanoid?.autoUpdateHumanBones;
  if (humanoid) humanoid.autoUpdateHumanBones = false;

  const nodes = new Map(), materials = new Map(), layers = new Map(), defaults = new Map();
  const expressionDefaults = new Map((expressions?.expressions || []).map(e => [e.expressionName, e.weight]));
  const colorBinds = [];
  for (const expression of expressions?.expressions || []) {
    for (const bind of expression.binds) {
      if (bind instanceof VRMExpressionMaterialColorBind && bind.type === 'color') {
        colorBinds.push({ expression, original: bind, current: bind });
      }
    }
  }

  function rememberMaterial(material, index) {
    if (!material || !Number.isInteger(index)) return;
    if (!materials.has(index)) materials.set(index, new Set());
    materials.get(index).add(material);
    if (!defaults.has(material)) defaults.set(material, {
      color: material.color?.clone(), opacity: material.opacity, transparent: material.transparent,
    });
  }

  scene.traverse(object => {
    if (!object.isMesh) return;
    // A glTF node can be a group of primitives, or a mesh with child nodes.
    // Use the closest node association, never all descendant meshes blindly.
    let owner = object, nodeIndex;
    while (owner && owner !== scene.parent) {
      const candidate = associations?.get(owner)?.nodes;
      if (Number.isInteger(candidate)) { nodeIndex = candidate; break; }
      owner = owner.parent;
    }
    if (Number.isInteger(nodeIndex) && json.nodes?.[nodeIndex]?.mesh !== undefined) {
      if (!nodes.has(nodeIndex)) nodes.set(nodeIndex, []);
      nodes.get(nodeIndex).push(object);
      layers.set(object, object.layers.mask);
    }
    const list = materialList(object);
    const mapping = associations?.get(object);
    const primitive = json.meshes?.[mapping?.meshes]?.primitives?.[mapping?.primitives];
    const sourceIndex = primitive?.material ?? associations?.get(list[0])?.materials;
    for (const material of list) {
      // MToon creates an outline material clone with no association. It draws
      // this same primitive and must receive its opacity and color overrides.
      rememberMaterial(material, associations?.get(material)?.materials ?? sourceIndex);
    }
  });
  // A material referenced by an expression must stay the same object; cloning
  // meshes/materials after VRM loading would detach those expression bindings.
  for (const { original } of colorBinds) {
    rememberMaterial(original.material, associations?.get(original.material)?.materials);
  }

  let springEnabled = true, preview = false, time = 0, savedTransforms = null, savedNormalizedPose = null;
  let disposed = false;
  const euler = new THREE.Euler(), quaternion = new THREE.Quaternion();

  function restoreMaterials() {
    for (const [material, value] of defaults) {
      if (value.color) material.color.copy(value.color);
      material.opacity = value.opacity;
      if (material.transparent !== value.transparent) {
        material.transparent = value.transparent;
        material.needsUpdate = true;
      }
    }
  }

  function restoreColorBinds() {
    for (const entry of colorBinds) if (entry.current !== entry.original) {
      entry.expression.deleteBind(entry.current);
      entry.expression.addBind(entry.original);
      entry.current = entry.original;
    }
  }

  function setSpringEnabled(enabled) {
    if (enabled === springEnabled) return;
    springEnabled = enabled;
    scene.updateMatrixWorld(true);
    // reset() restores authored spring rotations and discards previous tails.
    // Do it on both transitions so re-enabling never resumes stale velocity.
    springs?.reset();
  }

  function normalizeSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Invalid avatar settings.');
    const hidden = settings.hidden_nodes ?? [];
    const colors = settings.material_colors ?? {};
    const values = settings.expressions ?? {};
    if (!Array.isArray(hidden) || hidden.some(n => !Number.isInteger(n) || !nodes.has(n))) throw new TypeError('Unknown drawable node.');
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) throw new TypeError('Invalid material colors.');
    for (const [key, rgba] of Object.entries(colors)) {
      if (!indexKey(key) || !materials.has(Number(key)) || !Array.isArray(rgba) || rgba.length !== 4 || !rgba.every(unit)) throw new TypeError('Invalid material color.');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Invalid expressions.');
    for (const [name, value] of Object.entries(values)) {
      if (!expressionDefaults.has(name) || !unit(value)) throw new TypeError('Unknown expression or invalid weight.');
    }
    if (settings.spring_enabled !== undefined && typeof settings.spring_enabled !== 'boolean') throw new TypeError('Invalid spring setting.');
    return { hidden, colors, values, spring: settings.spring_enabled ?? true };
  }

  function apply(settings = {}) {
    if (disposed) return;
    const next = normalizeSettings(settings); // Validate everything before touching the model.
    for (const [object, mask] of layers) object.layers.mask = mask;
    for (const index of next.hidden) for (const object of nodes.get(index)) object.layers.mask = 0;
    for (const [name, weight] of expressionDefaults) expressions.setValue(name, weight);
    expressions?.update();
    restoreColorBinds();
    restoreMaterials();
    const changed = new Set();
    for (const [key, rgba] of Object.entries(next.colors)) for (const material of materials.get(Number(key))) {
      material.color?.setRGB(rgba[0], rgba[1], rgba[2], THREE.LinearSRGBColorSpace);
      material.opacity = rgba[3];
      const transparent = defaults.get(material).transparent || rgba[3] < 1;
      if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
      changed.add(material);
    }
    // The standard bind captures a rest color at construction and reinstates
    // it on every frame. Rebase only affected color binds through its public
    // constructor, retaining each expression's original absolute target.
    for (const entry of colorBinds) if (changed.has(entry.original.material)) {
      const original = entry.original;
      const replacement = new VRMExpressionMaterialColorBind({
        material: original.material, type: original.type,
        targetValue: original.targetValue, targetAlpha: original.targetAlpha,
      });
      entry.expression.deleteBind(original);
      entry.expression.addBind(replacement);
      entry.current = replacement;
    }
    for (const [name, weight] of Object.entries(next.values)) expressions.setValue(name, weight);
    expressions?.update();
    setSpringEnabled(next.spring);
  }

  function setPreviewMotion(enabled) {
    if (disposed) return false;
    enabled = !!enabled && !!humanoid;
    if (enabled === preview) return preview;
    if (enabled) {
      savedTransforms = [];
      scene.traverse(object => savedTransforms.push([object, object.position.clone(), object.quaternion.clone(), object.scale.clone()]));
      savedNormalizedPose = humanoid.getNormalizedPose();
      humanoid.autoUpdateHumanBones = true;
      humanoid.resetNormalizedPose();
      time = 0;
      preview = true;
    } else {
      preview = false;
      humanoid.autoUpdateHumanBones = false;
      humanoid.setNormalizedPose(savedNormalizedPose);
      for (const [object, position, rotation, scale] of savedTransforms || []) {
        object.position.copy(position); object.quaternion.copy(rotation); object.scale.copy(scale);
      }
      savedTransforms = null;
      savedNormalizedPose = null;
      scene.updateMatrixWorld(true);
      springs?.reset();
    }
    return preview;
  }

  function previewPose(delta) {
    time += delta;
    const rotation = (x, y, z) => quaternion.setFromEuler(euler.set(x, y, z)).toArray();
    // This is a small inspection movement, not retargeted dance animation.
    humanoid.setNormalizedPose({
      spine: { rotation: rotation(0, 0, Math.sin(time * 1.4) * .055) },
      chest: { rotation: rotation(0, Math.sin(time * .9) * .10, 0) },
      head: { rotation: rotation(Math.sin(time * .7) * .045, Math.sin(time) * .16, 0) },
      leftUpperArm: { rotation: rotation(0, 0, -.95 + Math.sin(time * 1.1) * .25) },
      rightUpperArm: { rotation: rotation(0, 0, .95 - Math.sin(time * 1.1) * .25) },
    });
  }

  function update(dt) {
    if (disposed || !vrm) return;
    const delta = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), .05) : 0;
    if (preview) previewPose(delta);
    // Public component order from pinned three-vrm 3.5.5 VRM.update(). Calling
    // components explicitly lets the spring toggle skip physics without
    // disabling expressions, constraints, material animation or raw clips.
    humanoid?.update();
    vrm.lookAt?.update(delta);
    expressions?.update();
    vrm.nodeConstraintManager?.update();
    if (springEnabled && delta > 0) springs?.update(delta);
    for (const material of vrm.materials || []) material.update?.(delta);
  }

  function reset() {
    if (disposed) return;
    setPreviewMotion(false);
    apply({});
    scene.updateMatrixWorld(true);
    springs?.reset();
  }

  function dispose() {
    if (disposed) return;
    reset();
    restoreColorBinds();
    if (humanoid) humanoid.autoUpdateHumanBones = originalAutoUpdate;
    disposed = true;
  }

  return { vrm, apply, update, reset, setPreviewMotion, get previewMotion() { return preview; }, dispose };
}
