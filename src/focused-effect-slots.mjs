import {z} from 'zod';
import {hash} from './parser.mjs';
import {buildFocusedGroupRequest} from './group-meaning.mjs';
import {requiredReceiverOutputRoleInstructions} from './receiver-role-inventory.mjs';
export const effectSlotInstructions="Required effect-slot wire: outputRoleDescriptions has exactly the supplied focus member roleIds. Fill EACH with a complete Korean conditional receiver.field/action responsibility sentence, not a label. output holds returns and non-inventory effects; do not repeat slot roles there. The host copies your strings verbatim into canonical OUTPUT, never supplies meaning. Keep local_use return and effect separate, each action reachability independent of later construction success. append_request is a request, not proven list mutation/type/contents. Preserve own call-site evidence; no child guards/formulas/arguments, invented effects/edges/constructor invocations or runtime success guarantee. Slots and role count do not prove correctness.";
export function buildEffectSlotFocusedRequest(group,children,options={}){
 const base=buildFocusedGroupRequest(group,children,options);
 if(base.instructions.split(requiredReceiverOutputRoleInstructions).length!==2)throw new Error('Effect slot instruction boundary unavailable');
 const request={instructions:base.instructions.replace(requiredReceiverOutputRoleInstructions,effectSlotInstructions).replace('"output":string[],"childUses"','"output":string[],"outputRoleDescriptions":{roleId:string},"childUses"'),input:base.input};
 readEffectSlotRoles(request,options.focusMemberId);return request;
}
export function readEffectSlotRoles(request,focusMemberId){
 const data=JSON.parse(request.input);if(typeof focusMemberId!=='string'||data.focusMemberId!==focusMemberId||data.outputMemberCount!==1||JSON.stringify(data.outputMemberIds)!==JSON.stringify([focusMemberId]))throw new Error('Effect slots require an exact focused boundary');
 const matches=(data.memberLedgers??[]).filter(member=>member.id===focusMemberId);if(matches.length!==1)throw new Error('Effect slot target missing or duplicated');
 const inventory=matches[0].requiredReceiverOutputRoles,rows=inventory?.roles;
 if(!Array.isArray(rows)||!rows.length||inventory.count!==rows.length||!Array.isArray(inventory.roleIds)||JSON.stringify(inventory.roleIds)!==JSON.stringify(rows.map(row=>row.roleId))||new Set(inventory.roleIds).size!==rows.length)throw new Error('Supplied required effect roles unavailable');
 for(const row of rows)if(typeof row.roleId!=='string'||!row.roleId||typeof row.receiver!=='string'||!row.receiver||typeof row.field!=='string'||!row.field||!['read_write','append_request'].includes(row.actionKind)||!Array.isArray(row.directActionIndices)||!Array.isArray(row.viaCalls)||!row.directActionIndices.length&&!row.viaCalls.length)throw new Error('Invalid supplied effect role');
 return structuredClone(rows);
}
export function effectSlotContract(request,baseMeaningSchema,focusMemberId){
 const roles=readEffectSlotRoles(request,focusMemberId),roleIds=roles.map(row=>row.roleId),slots=z.object(Object.fromEntries(roleIds.map(id=>[id,z.string().min(1)]))).strict();
 const wireSchema=z.object({id:z.string(),members:z.array(baseMeaningSchema.extend({outputRoleDescriptions:slots}).strict())}).strict();
 return {roles,roleIds,wireSchema,zodSchema:z.toJSONSchema(wireSchema),sdkSchema:z.toJSONSchema(wireSchema,{target:'draft-7'})};
}
export function projectEffectSlotOutput(raw,contract,groupId,focusMemberId){
 const wire=contract.wireSchema.parse(raw);if(wire.id!==groupId||wire.members.length!==1||wire.members[0].id!==focusMemberId)throw new Error('Effect slot focused output identity mismatch');
 const member=wire.members[0],{outputRoleDescriptions,...meaning}=member,rawSlots=structuredClone(outputRoleDescriptions),audit=contract.roleIds.map((roleId,index)=>({roleId,canonicalOutputIndex:meaning.output.length+index,textSHA:hash(rawSlots[roleId])}));
 return {canonicalWire:{id:groupId,members:[{...meaning,output:[...meaning.output,...contract.roleIds.map(id=>rawSlots[id])]}]},rawSlots,audit};
}
