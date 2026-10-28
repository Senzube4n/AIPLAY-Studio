/** Fixed file inputs used by Studio's bundled, non-downloading H3 guide nodes. */
export const H3_CONTROL_MODEL_INPUTS = Object.freeze({
  AiplayH3DepthGuide: {
    model_name: { name: "depth_anything_v2_vits.pth", relative: "depth-anything/Depth-Anything-V2-Small/depth_anything_v2_vits.pth", bytes: 99218434 },
  },
  AiplayH3PoseGuide: {
    detector_name: { name: "yolox_l.torchscript.pt", relative: "hr16/yolox-onnx/yolox_l.torchscript.pt", bytes: 217697649 },
    pose_name: { name: "dw-ll_ucoco_384_bs5.torchscript.pt", relative: "hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt", bytes: 135059124 },
  },
});
export const isH3ControlModelInput = (nodeClass, input) => Object.hasOwn(H3_CONTROL_MODEL_INPUTS, nodeClass) && Object.hasOwn(H3_CONTROL_MODEL_INPUTS[nodeClass], input);
export const h3ControlModelInput = (nodeClass, input, value) => {
  if (!isH3ControlModelInput(nodeClass, input)) return null;
  const field = H3_CONTROL_MODEL_INPUTS[nodeClass]?.[input];
  return field?.name === value ? field : null;
};
