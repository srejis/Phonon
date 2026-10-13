/** Source-role attention for multi-member groups. No graph mutation or runtime claims. */
const list=value=>Array.isArray(value)?value:[];
const receiverOK=n=>n?.language==='python'&&n.classContext?.methodStatic===false&&typeof n.classContext.initializationNodeId==='string'&&list(n.bindings).filter(b=>b.name===n.classContext.receiver).length===1&&list(n.bindings).some(b=>b.name===n.classContext.receiver&&b.kind==='parameter'&&b.scope===n.name);
const refOK=(n,r)=>r?.kind==='class_state'&&r.object===n.classContext.receiver&&list(n.classContext.fieldOwners).some(o=>o.name===r.field&&o.static===false&&o.ownerId===r.targetId);
export function buildReceiverRoleInventory(group,externalChildren=[],sourceNodes=[]){
 const members=list(group?.members);if(members.length<2||!members.some(receiverOK))return null;
 const memberIds=members.map(n=>n.id),childIds=list(externalChildren).map(n=>n.id),sources=new Map();
 for(const node of list(sourceNodes)){if(!sources.has(node.id))sources.set(node.id,[]);sources.get(node.id).push(node);}
 const sourceFor=id=>sources.get(id)?.length===1?sources.get(id)[0]:undefined;
 const owners=[...members.map((node,index)=>({node,kind:'member',index})),...childIds.filter(id=>members.some(n=>list(n.calls).some(c=>c.targetId===id&&c.status==='confirmed_same_file'))).map(id=>({node:sourceFor(id),kind:'child',index:childIds.indexOf(id)}))];
 const actions=[],uses=[],parameters=members.map((n,i)=>[i,list(n.bindings).flatMap((b,j)=>b.kind==='parameter'&&b.scope===n.name&&b.name!==n.classContext?.receiver?[j]:[])]).filter(r=>r[1].length);
 for(const owner of owners){const n=owner.node;if(!receiverOK(n))continue;
  for(const [refIndex,r]of list(n.references).entries())if(refOK(n,r)&&r.access==='read_write'){
   const facts=list(n.facts).map((f,i)=>({f,i})).filter(({f})=>f.kind==='augmented_assignment'&&f.line===r.line),refs=list(n.references).filter(x=>refOK(n,x)&&x.access==='read_write'&&x.line===r.line);
   if(!Number.isInteger(r.line)||r.line<1||facts.length!==1||refs.length!==1)continue;
   actions.push([owner.kind,owner.index,r.object,r.field,'read_write',r.line,refIndex,facts[0].i,null]);
  }
  for(const [callIndex,c]of list(n.calls).entries()){
   const parts=typeof c.name==='string'?c.name.split('.'):[];if(parts.length!==3||parts[0]!==n.classContext.receiver||parts[2]!=='append')continue;
   const refs=list(n.references).map((r,i)=>({r,i})).filter(({r})=>refOK(n,r)&&r.field===parts[1]&&r.line===c.line),facts=list(n.facts).map((f,i)=>({f,i})).filter(({f})=>f.kind==='call'&&f.line===c.line&&typeof f.text==='string'&&f.text.trimStart().startsWith(c.name+'('));
   if(!Number.isInteger(c.line)||c.line<1||refs.length!==1||facts.length!==1)continue;
   actions.push([owner.kind,owner.index,parts[0],parts[1],'append_request',c.line,refs[0].i,facts[0].i,callIndex]);
  }
 }
 if(!actions.length)return null;
 const nodes=new Map(members.map(n=>[n.id,n]));for(const id of childIds){const node=sourceFor(id);if(node&&!nodes.has(id))nodes.set(id,node);}
 for(const [callerIndex,caller]of members.entries())if(receiverOK(caller))for(const [callIndex,c]of list(caller.calls).entries()){
  const child=nodes.get(c.targetId),parts=typeof c.name==='string'?c.name.split('.'):[];
  if(c.status!=='confirmed_same_file'||!receiverOK(child)||parts.length!==2||parts[0]!==caller.classContext.receiver||parts[1]!==child.name.split('.').at(-1)||caller.file!==child.file||caller.classContext.initializationNodeId!==child.classContext.initializationNodeId)continue;
  const kind=memberIds.includes(child.id)?'member':'child',index=kind==='member'?memberIds.indexOf(child.id):childIds.indexOf(child.id);
  for(const [actionIndex,a]of actions.entries())if(a[0]===kind&&a[1]===index)uses.push([callerIndex,callIndex,actionIndex]);
 }
 return {actionColumns:['ownerKind','ownerIndex','receiver','field','role','ownerLine','referenceIndex','factIndex','ownerCallIndex'],actions,useColumns:['callerMemberIndex','callIndex','actionIndex'],uses,parameterColumns:['memberIndex','parameterBindingIndices'],parameters};
}
export const receiverRoleInventoryInstructions='Receiver role inventory is source evidence, not runtime proof. Member/child indices address existing ledgers. read_write requires existing state INPUT and conditional state-update OUTPUT; append_request is an actual method request, not guaranteed list mutation. Each use links only a matched receiver/class confirmed call. Preserve action reachability independently of later construction. Parameter rows point to declared bindings: retain source-backed INPUT roles, not invented uses. Internal delegation retains target action roles without formulas/guards. Cite caller sites for uses, owner coordinates only for own actions; origin references never invoke constructors. Keep all supplied child IPO and original roles. External owner ref/fact indices are stored graph provenance, not transmitted child source; never claim reading an unsupplied external body.';

/** Required role attention projected only from existing source actions and matched uses. */
export function buildRequiredReceiverOutputRoles(group,inventory,externalChildren=[]){
 const members=list(group?.members);if(members.length<2||!inventory)return [];
 const actions=list(inventory.actions),children=list(externalChildren);
 return members.map((member,memberIndex)=>{
  const rows=[],identities=new Map();
  if(!receiverOK(member))return {count:0,roleIds:[],roles:[]};
  const validAction=index=>Number.isInteger(index)&&index>=0&&index<actions.length&&Array.isArray(actions[index])&&typeof actions[index][3]==='string'&&['read_write','append_request'].includes(actions[index][4]);
  const add=(actionIndex,callIndex)=>{
   if(!validAction(actionIndex))return;const action=actions[actionIndex],identity=JSON.stringify([member.classContext.initializationNodeId,member.classContext.receiver,action[3],action[4]]);
   let row=identities.get(identity);if(!row){row={roleId:'receiver-output:'+rows.length,receiver:member.classContext.receiver,field:action[3],actionKind:action[4],directActionIndices:[],viaCalls:[]};identities.set(identity,row);rows.push(row);}
   if(callIndex===null){if(!row.directActionIndices.includes(actionIndex))row.directActionIndices.push(actionIndex);}
   else if(!row.viaCalls.some(c=>c.callIndex===callIndex&&c.sourceActionIndex===actionIndex))row.viaCalls.push({callIndex,sourceActionIndex:actionIndex});
  };
  actions.forEach((action,index)=>{if(Array.isArray(action)&&action[0]==='member'&&action[1]===memberIndex&&action[2]===member.classContext.receiver)add(index,null);});
  for(const use of list(inventory.uses)){
   if(!Array.isArray(use)||use[0]!==memberIndex)continue;const [_,callIndex,actionIndex]=use;
   if(!Number.isInteger(callIndex)||callIndex<0||!validAction(actionIndex))continue;
   const call=list(member.calls)[callIndex],action=actions[actionIndex],target=action[0]==='member'?members[action[1]]:action[0]==='child'?children[action[1]]:null;
   if(!target||call?.status!=='confirmed_same_file'||call.targetId!==target.id)continue;
   add(actionIndex,callIndex);
  }
  return {count:rows.length,roleIds:rows.map(row=>row.roleId),roles:rows};
 });
}
export const requiredReceiverOutputRoleInstructions="requiredReceiverOutputRoles is this member's exact DISTINCT source-backed OUTPUT role inventory. Represent EVERY receiver.field/actionKind listed in OUTPUT, even when obtained through a call. count counts roles, not sentences; one item may name several roles. directActionIndices and viaCalls point only to existing inventory actions/call indices. A local_use return does not absorb a separate state update; no own write or ignored return does not erase a supplied delegated effect. Retain each action's reachability independently of later construction success, without target guards/formulas/arguments. append_request is a requested method action, not type/listcontents/mutation success proof. Use own call evidence for delegated roles, owner action coordinates only for directly owned roles. Do not add effects, edges, constructor invocations or traces.";
