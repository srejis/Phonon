import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSQL} from '../src/sql-parser.mjs';
test('explicit SQLite foreign_keys preserves configuration and parses schema constraints',()=>{
 const result=parseSQL('-- migration\nPRAGMA foreign_keys = ON;\nCREATE TABLE parent(id TEXT PRIMARY KEY);\nCREATE TABLE child(id TEXT, parent_id TEXT REFERENCES parent(id), UNIQUE(id,parent_id));\nINSERT OR IGNORE INTO parent(id) VALUES (\'seed\');');
 assert.equal(result.dialect,'SQLite');assert.deepEqual(result.ast[0],{type:'pragma',name:'foreign_keys',value:'ON',line:2});assert.equal(result.ast.length,4);assert.equal(result.ast[2].type,'create');assert.equal(result.ast[3].type,'insert');
});
test('common SQL retains honest default dialect and quoted pragma is not a directive',()=>{
 const result=parseSQL("SELECT 'PRAGMA foreign_keys = ON;' AS text;");assert.equal(result.dialect,'Postgresql');assert.match(result.dialectBasis,/not established/);assert.equal(result.ast[0].type,'select');
});
test('unknown pragma and malformed SQLite are rejected rather than omitted',()=>{
 assert.throws(()=>parseSQL('PRAGMA unknown_setting = ON; CREATE TABLE x(id TEXT);'));
 assert.throws(()=>parseSQL('PRAGMA foreign_keys = ON; CREATE TABLE broken(;'));
});
