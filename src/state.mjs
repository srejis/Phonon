import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

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
    // Windows readers may briefly hold a file handle during atomic replacement.
    // Retry only that filesystem sharing failure; never delete the old state.
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temp,file);break;}
      catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
    }
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
  const ownerStartId = processStartId(process.pid);
  if (!ownerStartId) throw new Error('Cannot verify host process identity');
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Project is already running: ${id}`); throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, ownerStartId, acquiredAt: new Date().toISOString() }));
    heldLocks.set(id, { file, token });
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  } finally { fs.closeSync(fd); }
  return { id, token, ownerStartId };
}
export function releaseLock(id) {
  checkedId(id);
  const held = heldLocks.get(id);
  if (!held) throw new Error(`No lock owned by this process: ${id}`);
  for(let attempt=0;;attempt++){
    const saved=JSON.parse(fs.readFileSync(held.file,'utf8'));
    if(saved.token!==held.token||saved.pid!==process.pid||saved.ownerStartId!==processStartId(process.pid))throw new Error('Lock ownership changed');
    try{fs.unlinkSync(held.file);break;}
    catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  }
  heldLocks.delete(id);
}

const activeJobStatuses = new Set(['queued', 'running']);
const terminalJobStatuses = new Set(['completed', 'failed', 'api_blocked']);
let ownStartId;
function processStartId(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownStartId !== undefined) return ownStartId;
  let value = null;
  try {
    if (process.platform === 'win32') {
      value = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
        '(Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()'],
        {encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
    } else if (process.platform === 'linux') {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
  } catch {}
  if (!value || !/^\d+$/.test(value)) value = null;
  if (pid === process.pid) ownStartId = value;
  return value;
}
function ownerState(pid, startId) {
  if(!Number.isInteger(pid)||pid<=0||typeof startId!=='string')return 'unknown';
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  const current = processStartId(pid);
  return current && startId && current === startId ? 'verified' : 'unknown';
}
function readJsonOptional(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function assertLockOwner(id, token) {
  const held = heldLocks.get(checkedId(id));
  if (!held || held.token !== token) throw new Error('Job lock is not held by this process');
  const saved = readJsonOptional(held.file);
  if (!saved || saved.token !== token || saved.pid !== process.pid ||
      saved.ownerStartId !== processStartId(process.pid)) throw new Error('Job lock ownership changed');
  return saved;
}
export function writeJob(id, job) {
  const owned = assertLockOwner(id, job.jobToken);
  if (job.jobId !== owned.token || job.ownerPID !== owned.pid ||
      job.ownerStartId !== owned.ownerStartId) throw new Error('Job identity does not match its lock');
  if (!activeJobStatuses.has(job.status) && !terminalJobStatuses.has(job.status)) throw new Error('Invalid persisted job status');
  // Only host-owned metadata; never store source, provider responses, or credentials.
  const fields = ['jobId','jobToken','ownerPID','ownerStartId','status','queuedAt','startedAt','endedAt',
    'processed','reused','generated','cacheMigrations','cacheRejected','qualityStatus','failureCode','publicReason'];
  const record = Object.fromEntries(fields.filter(key=>job[key]!==undefined).map(key=>[key,job[key]]));
  record.updatedAt = new Date().toISOString();
  const directory = projectDir(id);
  if (terminalJobStatuses.has(record.status)) atomicJson(path.join(directory,'jobs',owned.token+'.json'),record);
  atomicJson(path.join(directory,'job.json'),record);
  return record;
}
export function readJob(id) {
  const directory = projectDir(id);
  let record, lock;
  try { record = readJsonOptional(path.join(directory,'job.json')); lock = readJsonOptional(path.join(directory,'run.lock')); }
  catch { return {status:'unknown',reasonCode:'UNREADABLE_JOB_STATE',ownerVerified:false}; }
  if (!record) return lock ? {status:'unknown',reasonCode:'LOCK_WITHOUT_JOB',ownerVerified:false} : null;
  const matching = lock && lock.token===record.jobToken && record.jobId===record.jobToken &&
    lock.pid===record.ownerPID && lock.ownerStartId===record.ownerStartId;
  const exposed = {...record, ...(record.publicReason ? {reason:record.publicReason} : {})};
  if (activeJobStatuses.has(record.status)) {
    if (!matching) return {...exposed,status:'unknown',recordedStatus:record.status,reasonCode:'LOCK_JOB_MISMATCH',ownerVerified:false};
    const owner = ownerState(record.ownerPID,record.ownerStartId);
    // An owner may finish while the OS identity probe is in flight. Prefer
    // its newly published terminal record over an obsolete active sample.
    const afterProbe=readJsonOptional(path.join(directory,'job.json'));
    if(afterProbe?.jobToken===record.jobToken&&terminalJobStatuses.has(afterProbe.status))return readJob(id);
    if (owner === 'dead') return {...exposed,status:'interrupted',recordedStatus:record.status,reasonCode:'OWNER_EXITED',ownerVerified:false};
    if (owner !== 'verified') return {...exposed,status:'unknown',recordedStatus:record.status,reasonCode:'OWNER_UNVERIFIED',ownerVerified:false};
    return {...exposed,ownerVerified:true};
  }
  if (!terminalJobStatuses.has(record.status)) return {...exposed,status:'unknown',reasonCode:'INVALID_JOB_STATUS',ownerVerified:false};
  if (lock && !matching) return {...exposed,status:'unknown',recordedStatus:record.status,reasonCode:'NEW_LOCK_WITH_OLD_JOB',ownerVerified:false};
  return {...exposed,ownerVerified:null};
}
