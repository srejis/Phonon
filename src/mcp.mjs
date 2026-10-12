import {MIN_INPUT_TOKENS,MAX_INPUT_TOKENS,DEFAULT_INPUT_TOKENS} from './analysis-budget.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerProject, listProjects, getStatus, requestAnalysis, getNode } from './engine.mjs';

const defaultEngine = { registerProject, listProjects, getStatus, requestAnalysis, getNode };
const identifier = () => z.string().min(1).max(2048);
const asResult = value => ({content: [{type: 'text', text: JSON.stringify(value ?? null)}]});

// Dependency override allows protocol integration tests without a paid model request.
export function createPhononServer(engine = defaultEngine) {
  const server = new McpServer({name: 'phonon', version: '0.0.1'});
  const safe = operation => async args => {
    try {
      return asResult(await operation(args));
    } catch {
      // Never return raw engine/provider messages, paths, credentials, or stacks.
      return {...asResult({error: {code: 'PHONON_OPERATION_FAILED', message: 'Operation failed. Check local project configuration and status.'}}), isError: true};
    }
  };
  server.registerTool('list_projects', {
    description: 'List projects registered in the local Phonon engine.',
    inputSchema: {},
    annotations: {readOnlyHint: true}
  }, safe(() => engine.listProjects()));
  server.registerTool('register_project', {
    description: 'Register a local source directory for read-only analysis.',
    inputSchema: {name: z.string().min(1).max(200), path: identifier()}
  }, safe(({name, path}) => engine.registerProject(name, path)));
  server.registerTool('analysis_status', {
    description: 'Read shared cross-process analysis status and progress. queued/running requires matching lock token and verified owner process start identity; unknown/interrupted never authorizes automatic restart. coverage and unexplainedNodeIds distinguish not-generated nodes from stale existing explanations; coverage.scopeKind and complete distinguish partial from whole coverage.',
    inputSchema: {projectId: identifier()},
    annotations: {readOnlyHint: true}
  }, safe(({projectId}) => engine.getStatus(projectId)));
  server.registerTool('request_analysis', {
    description: 'Start bounded asynchronous project analysis. maxCalls defaults to 0, so omitted budget never authorizes paid model calls. File and node selections form a union, expanded to required dependency context. Poll analysis_status for completion.',
    inputSchema: {
      projectId: identifier(),
      files: z.array(identifier()).optional(),
      nodeIds: z.array(identifier()).optional(),
      maxCalls: z.number().int().min(0).max(24).default(0),
      maxInputTokens: z.number().int().min(MIN_INPUT_TOKENS).max(MAX_INPUT_TOKENS).optional(),
      maxOutputTokens: z.number().int().min(64).max(2000).optional()
    }
  }, safe(({projectId, files, nodeIds, maxCalls = 0, maxInputTokens, maxOutputTokens}) =>
    engine.requestAnalysis(projectId, {
      maxCalls,
      ...(files === undefined ? {} : {files}),
      ...(nodeIds === undefined ? {} : {nodeIds}),
      ...(maxInputTokens === undefined ? {} : {maxInputTokens}),
      ...(maxOutputTokens === undefined ? {} : {maxOutputTokens})
    })
  ));
  server.registerTool('get_node', {
    description: 'Read a stored hierarchical explanation and evidence for a code node.',
    inputSchema: {projectId: identifier(), nodeId: identifier()},
    annotations: {readOnlyHint: true}
  }, safe(({projectId, nodeId}) => engine.getNode(projectId, nodeId)));
  return server;
}

export async function startStdioServer() {
  const server = createPhononServer();
  await server.connect(new StdioServerTransport());
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  startStdioServer().catch(() => {
    process.stderr.write('Phonon MCP server failed to start.\n');
    process.exitCode = 1;
  });
}
