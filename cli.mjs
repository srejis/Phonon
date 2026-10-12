import {registerProject,listProjects,getStatus,requestAnalysis,getNode,waitForJob} from './src/engine.mjs';
import {clearAPIStop} from './src/llm.mjs';
const [command,...args]=process.argv.slice(2);
try{
 let result;
 if(command==='resume-api'){if(args[0]!=='--confirmed-by-user')throw new Error('Resume requires explicit user confirmation');clearAPIStop();result={status:'resume_authorized'};}
 else if(command==='register')result=registerProject(args[0],args[1]);
 else if(command==='projects')result=listProjects();
 else if(command==='status')result=getStatus(args[0]);
 else if(command==='node')result=getNode(args[0],args[1]);
 else if(command==='analyze'){
  const maxCalls=Number(args[1]??0),files=args.slice(2);requestAnalysis(args[0],{maxCalls,files:files.length?files:undefined});result=await waitForJob(args[0]);if(result.status!=='completed')process.exitCode=1;
 }else throw new Error('Usage: node cli.mjs register <name> <source-dir> | projects | status <id> | analyze <id> [max-calls=0] [relative-files...] | node <id> <node-id>');
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}