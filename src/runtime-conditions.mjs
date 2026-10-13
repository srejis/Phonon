import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// These local modules are imported statically by the analysis host.
// H3 is intentionally excluded: engine imports it with its content hash.
export const STATIC_ANALYSIS_FILES = Object.freeze([
  'src/engine.mjs', 'src/analysis-budget.mjs', 'src/parser.mjs',
  'src/llm.mjs', 'src/state.mjs', 'src/relations.mjs',
  'src/dependency-groups.mjs', 'src/group-meaning.mjs', 'src/group-request-encoding.mjs',
  'src/meaning-language.mjs', 'src/python-contracts.mjs',
  'src/input-role-hints.mjs', 'src/python-shared-effects.mjs', 'src/python-module-contracts.mjs', 'src/python-path-contracts.mjs', 'src/css-parser.mjs',
  'src/sql-parser.mjs', 'src/type-context.mjs',
  'src/failure-policy.mjs', 'src/runtime-conditions.mjs',
  'package.json', 'package-lock.json',
]);
const defaultRoot = path.resolve(import.meta.dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function captureRuntimeConditions({root = defaultRoot, files = STATIC_ANALYSIS_FILES} = {}) {
  const resolvedRoot = path.resolve(root);
  const names = [...new Set(files)].sort();
  const records = names.map(file => {
    if (typeof file !== 'string' || !['.mjs', '.json'].includes(path.extname(file))) {
      throw new TypeError('Runtime condition files must be local .mjs or .json files');
    }
    const absolute = path.resolve(resolvedRoot, file);
    const relative = path.relative(resolvedRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Runtime condition file is outside host root');
    }
    return Object.freeze({file: relative.split(path.sep).join('/'), sha256: digest(fs.readFileSync(absolute))});
  });
  return Object.freeze({
    root: resolvedRoot,
    files: Object.freeze(records),
    fingerprint: digest(JSON.stringify(records)),
  });
}

// Import this helper statically when the host starts. It cannot reconstruct
// the conditions of a host which had loaded old modules before this import.
export const loadedRuntimeConditions = captureRuntimeConditions();

export function checkRuntimeConditions(captured = loadedRuntimeConditions) {
  const changedFiles = [];
  for (const record of captured.files) {
    try {
      const current = digest(fs.readFileSync(path.join(captured.root, record.file)));
      if (current !== record.sha256) changedFiles.push({file: record.file, reason: 'content_changed'});
    } catch (error) {
      changedFiles.push({file: record.file, reason: 'unavailable', code: error.code ?? 'READ_ERROR'});
    }
  }
  return {
    restartRequired: changedFiles.length > 0,
    runtimeFingerprint: captured.fingerprint,
    changedFiles,
  };
}

export function assertRuntimeConditions(captured = loadedRuntimeConditions) {
  const result = checkRuntimeConditions(captured);
  if (result.restartRequired) {
    const error = new Error('분석 프로그램 코드가 실행 후 변경되었습니다. 호스트를 다시 시작한 뒤 분석해 주세요.');
    error.code = 'RUNTIME_RESTART_REQUIRED';
    error.changedFiles = result.changedFiles;
    throw error;
  }
  return result;
}
