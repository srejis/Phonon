import sql from 'node-sql-parser';

// SQLite declares its dialect with an actual leading foreign_keys directive.
// This statement is parsed as configuration, never sent to a database or discarded.
const leadingForeignKeys = /^(\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*)PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|TRUE|FALSE|0|1)\s*;/i;
export function parseSQL(source) {
 const match=source.match(leadingForeignKeys);
 if(!match)return {dialect:'Postgresql',dialectBasis:'default grammar; source dialect not established',ast:new sql.Parser().astify(source,{database:'Postgresql'})};
 const prefix=match[0],line=source.slice(0,match[1].length).split('\n').length;
 const remainder=prefix.replace(/[^\r\n]/g,' ')+source.slice(prefix.length);
 const parsed=new sql.Parser().astify(remainder,{database:'SQLite'});
 const pragma={type:'pragma',name:'foreign_keys',value:match[2].toUpperCase(),line};
 return {dialect:'SQLite',dialectBasis:'explicit leading PRAGMA foreign_keys directive',ast:[pragma,...(Array.isArray(parsed)?parsed:parsed?[parsed]:[])]};
}
