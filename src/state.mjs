import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const localDir = path.join(root, '.local');
const registryPath = path.join(localDir, 'registry.json');
const projectsRoot = path.join(localDir, 'projects');
const heldLocks = new Map();
const validId = /^[a-f0-9]{32}$/;

function checkedId(id) {
  if (typeof id !== 'string' || !validId.test(id)) throw new Error('Invalid project id');
  return id;
}
function atomicJson(file, value) {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw new TypeError('State must be JSON serializable');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function registry() {
  let data;
  try { data = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: [] }; throw error; }
  if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error('Invalid project registry');
  return data;
}
function canonicalSource(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new TypeError('Source path is required');
  const actual = fs.realpathSync(sourcePath);
  const allowed = fs.realpathSync('D:\\project');
  const relative = path.relative(allowed, actual);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Source must be inside D:\\project');
  }
  if (!fs.statSync(actual).isDirectory()) throw new Error('Source must be a directory');
  return actual;
}

export function registerProject(name, sourcePath) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('Project name is required');
  const actual = canonicalSource(sourcePath);
  const id = crypto.createHash('sha256').update(actual.toLowerCase()).digest('hex').slice(0, 32);
  fs.mkdirSync(localDir, { recursive: true });
  const registryLock = path.join(localDir, 'registry.lock');
  let fd;
  try { fd = fs.openSync(registryLock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Project registration is already running'); throw error; }
  try {
    const data = registry();
    const found = data.projects.find(project => project.sourcePath.toLowerCase() === actual.toLowerCase());
    if (found) return { ...found };
    if (data.projects.some(project => project.id === id)) throw new Error('Project identity collision');
    const project = { id, name: name.trim(), sourcePath: actual, createdAt: new Date().toISOString() };
    data.projects.push(project);
    atomicJson(registryPath, data);
    return { ...project };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(registryLock);
  }
}
export function listProjects() { return registry().projects.map(project => ({ ...project })); }
export function getProject(id) {
  checkedId(id);
  const found = registry().projects.find(project => project.id === id);
  if (!found) throw new Error(`Unknown project: ${id}`);
  return { ...found };
}
export function projectDir(id) {
  getProject(id);
  const directory = path.join(projectsRoot, id);
  // Reject existing redirected analysis directories as well as lexical traversal IDs.
  if (fs.existsSync(projectsRoot)) {
    const actualRoot = fs.realpathSync(projectsRoot);
    if (path.relative(localDir, actualRoot) !== 'projects') throw new Error('Project storage root is redirected');
  }
  if (fs.existsSync(directory) && path.relative(projectsRoot, fs.realpathSync(directory)) !== id) {
    throw new Error('Project storage directory is redirected');
  }
  return directory;
}
export function readLatest(id) {
  const file = path.join(projectDir(id), 'latest.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeLatest(id, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('Snapshot must be an object');
  atomicJson(path.join(projectDir(id), 'latest.json'), snapshot);
}
export function writeFailure(id, failure) {
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) throw new TypeError('Failure must be an object');
  const file = path.join(projectDir(id), 'failures', `${Date.now()}-${crypto.randomUUID()}.json`);
  atomicJson(file, failure);
  return file;
}
export function acquireLock(id) {
  const directory = projectDir(id);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'run.lock');
  const token = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Project is already running: ${id}`); throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }));
    heldLocks.set(id, { file, token });
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  } finally { fs.closeSync(fd); }
  return { id, token };
}
export function releaseLock(id) {
  checkedId(id);
  const held = heldLocks.get(id);
  if (!held) throw new Error(`No lock owned by this process: ${id}`);
  const saved = JSON.parse(fs.readFileSync(held.file, 'utf8'));
  if (saved.token !== held.token) throw new Error('Lock ownership changed');
  fs.unlinkSync(held.file);
  heldLocks.delete(id);
}
