/** A quick viewport pose for verified VRM foot nodes; the existing joint command owns sync. */
export function mountAvatarFootReview({inspection,joints,documentRef=document,onPose}) {
  const row=documentRef.getElementById('foot-review-controls');
  const buttons={left:documentRef.getElementById('foot-review-left'),right:documentRef.getElementById('foot-review-right')};
  const left=inspection?.footControls?.leftFootNode,right=inspection?.footControls?.rightFootNode;
  const available=new Set((joints||[]).map(joint=>joint.index));
  const targets=inspection?.profile==='vrm'&&Number.isInteger(left)&&Number.isInteger(right)&&left!==right&&available.has(left)&&available.has(right)
    ?{left,right}:null;
  row.hidden=!targets;
  let activeSide=null;
  function paint(pose) {
    activeSide=Object.keys(buttons).find(side=>targets&&pose?.node_index===targets[side]&&pose.degrees!==0)||null;
    for(const [side,button] of Object.entries(buttons))
      button.setAttribute('aria-pressed',String(activeSide===side));
  }
  for(const [side,button] of Object.entries(buttons)) button.onclick=targets
    ?()=>onPose({node_index:targets[side],axis:'x',degrees:activeSide===side?0:25}) :null;
  paint(null);
  return {targets,paint,dispose(){for(const button of Object.values(buttons))button.onclick=null;row.hidden=true;}};
}
