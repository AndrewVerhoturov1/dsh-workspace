import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { TextDecoder } from 'node:util';

export const ARTIFACT_VALID = 'ARTIFACT_VALID';
export const ERROR_CODES = Object.freeze({
  BAD_ZIP:'ARTIFACT_BAD_ZIP', EMPTY:'ARTIFACT_EMPTY', FILENAME_MISMATCH:'ARTIFACT_FILENAME_MISMATCH',
  MANIFEST_MISSING:'ARTIFACT_MANIFEST_MISSING', MANIFEST_INVALID:'ARTIFACT_MANIFEST_INVALID',
  PROTOCOL_VERSION_MISMATCH:'ARTIFACT_PROTOCOL_VERSION_MISMATCH', REQUEST_MISMATCH:'ARTIFACT_REQUEST_MISMATCH',
  REPOSITORY_MISMATCH:'ARTIFACT_REPOSITORY_MISMATCH', BASE_COMMIT_MISMATCH:'ARTIFACT_BASE_COMMIT_MISMATCH',
  RESULT_TYPE_INVALID:'ARTIFACT_RESULT_TYPE_INVALID', PAYLOAD_MISSING:'ARTIFACT_PAYLOAD_MISSING',
  PATH_TRAVERSAL:'ARTIFACT_PATH_TRAVERSAL', ABSOLUTE_PATH:'ARTIFACT_ABSOLUTE_PATH',
  WINDOWS_DRIVE_PATH:'ARTIFACT_WINDOWS_DRIVE_PATH', UNC_PATH:'ARTIFACT_UNC_PATH', NTFS_ADS:'ARTIFACT_NTFS_ADS',
  SYMLINK:'ARTIFACT_SYMLINK', REPARSE_ENTRY:'ARTIFACT_REPARSE_ENTRY', DUPLICATE_PATH:'ARTIFACT_DUPLICATE_PATH',
  CASE_COLLISION:'ARTIFACT_CASE_COLLISION', WINDOWS_RESERVED_NAME:'ARTIFACT_WINDOWS_RESERVED_NAME',
  PATH_INVALID:'ARTIFACT_PATH_INVALID', SCOPE_VIOLATION:'ARTIFACT_SCOPE_VIOLATION', FORBIDDEN_PATH:'ARTIFACT_FORBIDDEN_PATH',
  COMPRESSED_SIZE_LIMIT:'ARTIFACT_COMPRESSED_SIZE_LIMIT', UNCOMPRESSED_SIZE_LIMIT:'ARTIFACT_UNCOMPRESSED_SIZE_LIMIT',
  ENTRY_SIZE_LIMIT:'ARTIFACT_ENTRY_SIZE_LIMIT', ENTRY_LIMIT:'ARTIFACT_ENTRY_LIMIT', ZIP_BOMB_RISK:'ARTIFACT_ZIP_BOMB_RISK',
  PATCH_INVALID:'ARTIFACT_PATCH_INVALID',
});
export const DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes:50*1024*1024, maxTotalUncompressedBytes:200*1024*1024,
  maxEntryUncompressedBytes:64*1024*1024, maxEntries:2000, maxCompressionRatio:100,
});

const EOCD=0x06054b50, CENTRAL=0x02014b50, LOCAL=0x04034b50, UTF8_FLAG=1<<11, ENCRYPTED_FLAG=1;
const UTF8 = new TextDecoder('utf-8',{fatal:true});
const SHA_RE=/^[0-9a-f]{40}$/i, REPO_RE=/^[^/\s]+\/[^/\s]+$/, DRIVE_RE=/^[A-Za-z]:[\\/]/;
const RESERVED=/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const RESULT_TYPES=new Set(['patch','files','hybrid_patch']);
const MANIFEST_KEYS=new Set(['protocolVersion','requestId','repository','baseCommit','resultType','patch','files','readRef','branch','generatedAt','description','inventory']);

const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(b){let c=0xffffffff;for(const x of b)c=CRC_TABLE[(c^x)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function hash(b){return crypto.createHash('sha256').update(b).digest('hex');}
function bad(code,{sha256='',details={},inventory=[]}={}){return Object.freeze({ok:false,status:code,code,sha256,validatedProtocolVersion:null,inventory,warnings:[],details:Object.freeze({...details})});}
function good(sha256,manifest,inventory){return Object.freeze({ok:true,status:ARTIFACT_VALID,code:ARTIFACT_VALID,sha256,validatedProtocolVersion:manifest.protocolVersion,requestId:manifest.requestId,repository:manifest.repository,baseCommit:manifest.baseCommit,resultType:manifest.resultType,inventory,warnings:[],details:Object.freeze({entryCount:inventory.length})});}

function checkExpected(e){
  if(!e||typeof e!=='object'||Array.isArray(e))throw new TypeError('expectedRequest must be an object');
  for(const k of ['requestId','repository','baseCommit','expectedFilename'])if(typeof e[k]!=='string'||!e[k])throw new TypeError(`expectedRequest.${k} must be a non-empty string`);
  if(!SHA_RE.test(e.baseCommit))throw new TypeError('expectedRequest.baseCommit must be a full 40-hex Git SHA');
  if(!REPO_RE.test(e.repository))throw new TypeError('expectedRequest.repository must be owner/repo');
  for(const k of ['allowedPaths','forbiddenPaths'])if(!Array.isArray(e[k])||e[k].some(v=>typeof v!=='string'||!v))throw new TypeError(`expectedRequest.${k} must be an array of non-empty strings`);
}
function limitsOf(o={}){const l={...DEFAULT_LIMITS,...(o||{})};for(const k of Object.keys(DEFAULT_LIMITS))if(!Number.isFinite(l[k])||l[k]<=0)throw new TypeError(`limits.${k} must be positive`);if(!Number.isInteger(l.maxEntries))throw new TypeError('limits.maxEntries must be integer');return l;}
function filenameOf(p){return path.basename(p);}
function eocdOffset(b){if(b.length<22)return-1;for(let i=b.length-22;i>=Math.max(0,b.length-22-0xffff);i--)if(b.readUInt32LE(i)===EOCD)return i;return-1;}
function decodeName(b,flags){if(flags&UTF8_FLAG){try{return UTF8.decode(b);}catch{return null;}}for(const x of b)if(x>127)return null;return b.toString('ascii');}
function fold(s){return s.normalize('NFC').toLowerCase().replaceAll('ß','ss').replaceAll('ς','σ');}

function classify(raw,{allowDirectory=true}={}){
  if(typeof raw!=='string'||!raw)return{ok:false,code:ERROR_CODES.PATH_INVALID,reason:'empty'};
  if(/^[\\/]{2}/.test(raw))return{ok:false,code:ERROR_CODES.UNC_PATH,reason:'unc'};
  if(DRIVE_RE.test(raw))return{ok:false,code:ERROR_CODES.WINDOWS_DRIVE_PATH,reason:'drive'};
  if(/^[\\/]/.test(raw))return{ok:false,code:ERROR_CODES.ABSOLUTE_PATH,reason:'absolute'};
  if(/[\u0000-\u001f\u007f]/u.test(raw))return{ok:false,code:ERROR_CODES.PATH_INVALID,reason:'control'};
  const sep=raw.replaceAll('\\','/'), dir=sep.endsWith('/'), body=dir?sep.slice(0,-1):sep;
  if(!body||(!allowDirectory&&dir))return{ok:false,code:ERROR_CODES.PATH_INVALID,reason:'directory'};
  const parts=body.split('/');
  if(parts.some(x=>x==='..'))return{ok:false,code:ERROR_CODES.PATH_TRAVERSAL,reason:'dotdot'};
  if(parts.some(x=>x===''||x==='.'))return{ok:false,code:ERROR_CODES.PATH_INVALID,reason:'segment'};
  for(const x of parts){if(x.includes(':'))return{ok:false,code:ERROR_CODES.NTFS_ADS,reason:'ads'};if(/[. ]$/u.test(x))return{ok:false,code:ERROR_CODES.PATH_INVALID,reason:'trailing'};if(RESERVED.test(x.split('.',1)[0]))return{ok:false,code:ERROR_CODES.WINDOWS_RESERVED_NAME,reason:'reserved'};}
  const structural=parts.join('/')+(dir?'/':''), normalized=structural.normalize('NFC');
  return{ok:true,structural,normalized,collisionKey:fold(normalized),isDirectory:dir};
}
function target(raw){return classify(raw,{allowDirectory:false});}
function scopeDesc(raw){const c=target(raw.replaceAll('\\','/').replace(/\/+$/u,''));if(!c.ok)throw new TypeError(`Invalid trusted scope: ${raw}`);return{normalized:c.normalized,key:fold(c.normalized)};}
function scopesOf(e){return{allowed:e.allowedPaths.map(scopeDesc),forbidden:e.forbiddenPaths.map(scopeDesc)};}
function within(t,s){const k=fold(t);return k===s.key||k.startsWith(`${s.key}/`);}
function scopeCode(t,s){for(const f of s.forbidden)if(within(t,f))return ERROR_CODES.FORBIDDEN_PATH;if(!s.allowed.some(a=>within(t,a)))return ERROR_CODES.SCOPE_VIOLATION;return null;}

function parseCentral(b){
  const eo=eocdOffset(b);if(eo<0||eo+22>b.length)return{error:'eocd'};
  const disk=b.readUInt16LE(eo+4), cdDisk=b.readUInt16LE(eo+6), onDisk=b.readUInt16LE(eo+8), count=b.readUInt16LE(eo+10), size=b.readUInt32LE(eo+12), off=b.readUInt32LE(eo+16), comment=b.readUInt16LE(eo+20);
  if(eo+22+comment!==b.length)return{error:'trailing_data'};if(disk||cdDisk||onDisk!==count)return{error:'multi_disk'};if(count===0xffff||size===0xffffffff||off===0xffffffff)return{error:'zip64'};if(off+size!==eo)return{error:'central_bounds'};
  const entries=[];let p=off;
  for(let i=0;i<count;i++){
    if(p+46>eo||b.readUInt32LE(p)!==CENTRAL)return{error:'central_header',index:i};
    const versionMadeBy=b.readUInt16LE(p+4), versionNeeded=b.readUInt16LE(p+6), flags=b.readUInt16LE(p+8), method=b.readUInt16LE(p+10), crc=b.readUInt32LE(p+16), compressedSize=b.readUInt32LE(p+20), uncompressedSize=b.readUInt32LE(p+24), nl=b.readUInt16LE(p+28), xl=b.readUInt16LE(p+30), cl=b.readUInt16LE(p+32), diskStart=b.readUInt16LE(p+34), externalAttrs=b.readUInt32LE(p+38), localOffset=b.readUInt32LE(p+42), end=p+46+nl+xl+cl;
    if(end>eo||diskStart)return{error:'central_entry'};if(compressedSize===0xffffffff||uncompressedSize===0xffffffff||localOffset===0xffffffff)return{error:'zip64_entry'};if(flags&ENCRYPTED_FLAG)return{error:'encrypted'};if(method!==0&&method!==8)return{error:'method'};
    const nameBytes=Buffer.from(b.subarray(p+46,p+46+nl)),rawName=decodeName(nameBytes,flags);if(rawName===null)return{error:'filename_encoding'};
    entries.push({versionMadeBy,versionNeeded,flags,method,crc,compressedSize,uncompressedSize,nameBytes,rawName,externalAttrs,localOffset});p=end;
  }
  if(p!==eo)return{error:'central_size'};return{entries,centralOffset:off};
}
function typeCode(e,c){const platform=e.versionMadeBy>>>8, mode=(e.externalAttrs>>>16)&0xffff, type=mode&0xf000, dos=e.externalAttrs&0xffff;if(platform===3&&type===0xa000)return ERROR_CODES.SYMLINK;if(platform===3&&type!==0&&type!==0x8000&&type!==0x4000)return ERROR_CODES.REPARSE_ENTRY;if(dos&0x0400)return ERROR_CODES.REPARSE_ENTRY;if(platform===3&&type===0x4000&&!c.isDirectory)return ERROR_CODES.REPARSE_ENTRY;if(platform===3&&type===0x8000&&c.isDirectory)return ERROR_CODES.REPARSE_ENTRY;return null;}
function entryData(b,e,centralOffset,max){const p=e.localOffset;if(p+30>centralOffset||b.readUInt32LE(p)!==LOCAL)return{error:'local_header'};const flags=b.readUInt16LE(p+6),method=b.readUInt16LE(p+8),nl=b.readUInt16LE(p+26),xl=b.readUInt16LE(p+28),ns=p+30,ds=ns+nl+xl,de=ds+e.compressedSize;if(flags&ENCRYPTED_FLAG||method!==e.method||de>centralOffset)return{error:'local_mismatch'};if(!Buffer.from(b.subarray(ns,ns+nl)).equals(e.nameBytes))return{error:'local_name'};let data;try{data=e.method===0?Buffer.from(b.subarray(ds,de)):zlib.inflateRawSync(b.subarray(ds,de),{maxOutputLength:max+1});}catch(err){return{error:'inflate',message:err.message};}if(data.length!==e.uncompressedSize||crc32(data)!==e.crc)return{error:'size_or_crc'};return{data,dataEnd:de};}
function manifestCode(m){
  if(!m||typeof m!=='object'||Array.isArray(m))return ERROR_CODES.MANIFEST_INVALID;
  for(const k of Object.keys(m))if(!MANIFEST_KEYS.has(k))return ERROR_CODES.MANIFEST_INVALID;
  if(!Number.isInteger(m.protocolVersion)||typeof m.requestId!=='string'||!m.requestId||typeof m.repository!=='string'||!REPO_RE.test(m.repository)||typeof m.baseCommit!=='string'||!SHA_RE.test(m.baseCommit)||typeof m.resultType!=='string'||!(m.patch===null||typeof m.patch==='string')||!Array.isArray(m.files)||m.files.some(x=>typeof x!=='string'||!x))return ERROR_CODES.MANIFEST_INVALID;
  for(const k of ['readRef','branch','generatedAt','description'])if(k in m&&typeof m[k]!=='string')return ERROR_CODES.MANIFEST_INVALID;if('inventory'in m&&!Array.isArray(m.inventory))return ERROR_CODES.MANIFEST_INVALID;
  if(!RESULT_TYPES.has(m.resultType))return ERROR_CODES.RESULT_TYPE_INVALID;
  if(m.resultType==='patch'&&(m.patch!=='changes.patch'||m.files.length!==0))return ERROR_CODES.MANIFEST_INVALID;
  if(m.resultType==='files'&&(m.patch!==null||m.files.length<1))return ERROR_CODES.MANIFEST_INVALID;
  if(m.resultType==='hybrid_patch'&&(m.patch!=='changes.patch'||m.files.length<1))return ERROR_CODES.MANIFEST_INVALID;
  const exact=new Set(),collisions=new Map();
  for(const p of m.files){const c=target(p);if(!c.ok)return c.code;if(exact.has(c.structural))return ERROR_CODES.DUPLICATE_PATH;exact.add(c.structural);const old=collisions.get(c.collisionKey);if(old!==undefined&&old!==c.structural)return ERROR_CODES.CASE_COLLISION;collisions.set(c.collisionKey,c.structural);}
  return null;
}
function utf8(b){try{return UTF8.decode(b);}catch{return null;}}
function diffHeaderPath(line,prefix){let v=line.slice(prefix.length);const tab=v.indexOf('\t');if(tab>=0)v=v.slice(0,tab);v=v.trimEnd();if(!v||v.startsWith('"'))return{error:ERROR_CODES.PATCH_INVALID};if(v==='/dev/null')return{path:null};if(v.startsWith('a/')||v.startsWith('b/'))v=v.slice(2);const c=target(v);return c.ok?{path:c.normalized}:{error:c.code};}
function validateDiff(text,scopes){
  if(typeof text!=='string'||!text||text.includes('\u0000'))return ERROR_CODES.PATCH_INVALID;const s=text.replaceAll('\r\n','\n');if(s.includes('\r'))return ERROR_CODES.PATCH_INVALID;const lines=s.split('\n');if(lines.at(-1)==='')lines.pop();let i=0,blocks=0;
  while(i<lines.length){
    while(i<lines.length&&(lines[i].startsWith('diff --git ')||lines[i].startsWith('index ')||lines[i].startsWith('new file mode ')||lines[i].startsWith('deleted file mode ')||lines[i].startsWith('similarity index ')))i++;
    const meta=[];while(i<lines.length&&/^(rename from |rename to |copy from |copy to )/u.test(lines[i])){const marker=lines[i].match(/^(rename from |rename to |copy from |copy to )/u)[0],c=target(lines[i].slice(marker.length));if(!c.ok)return c.code;meta.push(c.normalized);i++;}
    for(const p of meta){const c=scopeCode(p,scopes);if(c)return c;}
    if(i>=lines.length||!lines[i].startsWith('--- '))return ERROR_CODES.PATCH_INVALID;const old=diffHeaderPath(lines[i++],'--- ');if(old.error)return old.error;if(i>=lines.length||!lines[i].startsWith('+++ '))return ERROR_CODES.PATCH_INVALID;const neu=diffHeaderPath(lines[i++],'+++ ');if(neu.error)return neu.error;if(old.path===null&&neu.path===null)return ERROR_CODES.PATCH_INVALID;for(const p of [old.path,neu.path])if(p!==null){const c=scopeCode(p,scopes);if(c)return c;}
    let hunks=0;while(i<lines.length&&lines[i].startsWith('@@ ')){const m=lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u);if(!m)return ERROR_CODES.PATCH_INVALID;let o=m[2]===undefined?1:Number(m[2]),n=m[4]===undefined?1:Number(m[4]);i++;while(i<lines.length&&!lines[i].startsWith('@@ ')&&!lines[i].startsWith('diff --git ')&&!lines[i].startsWith('--- ')){const l=lines[i];if(l==='\\ No newline at end of file'){i++;continue;}if(l.startsWith(' ')){o--;n--;}else if(l.startsWith('-'))o--;else if(l.startsWith('+'))n--;else return ERROR_CODES.PATCH_INVALID;if(o<0||n<0)return ERROR_CODES.PATCH_INVALID;i++;if(o===0&&n===0)break;}if(o!==0||n!==0)return ERROR_CODES.PATCH_INVALID;hunks++;}
    if(hunks===0&&meta.length===0)return ERROR_CODES.PATCH_INVALID;blocks++;
  }
  return blocks?null:ERROR_CODES.PATCH_INVALID;
}
function basicProbe(p,size){const fd=fs.openSync(p,'r');try{const first=Buffer.alloc(Math.min(4,size));fs.readSync(fd,first,0,first.length,0);const ts=Math.min(size,22+0xffff),tail=Buffer.alloc(ts);fs.readSync(fd,tail,0,ts,size-ts);const eo=eocdOffset(tail);if(first.length<4||eo<0)return false;const sig=first.readUInt32LE(0);if(sig!==LOCAL&&sig!==EOCD)return false;return eo+22+tail.readUInt16LE(eo+20)===tail.length;}finally{fs.closeSync(fd);}}

export function validateArtifact(zipPath,expectedRequest){
  checkExpected(expectedRequest);const limits=limitsOf(expectedRequest.limits),scopes=scopesOf(expectedRequest);let stat;try{stat=fs.statSync(zipPath);}catch(e){return bad(ERROR_CODES.BAD_ZIP,{details:{reason:'file_missing',message:e.message}});}if(!stat.isFile())return bad(ERROR_CODES.BAD_ZIP,{details:{reason:'not_file'}});if(stat.size===0)return bad(ERROR_CODES.EMPTY,{details:{reason:'zero_byte'}});if(!basicProbe(zipPath,stat.size))return bad(ERROR_CODES.BAD_ZIP,{details:{reason:'basic_probe'}});if(filenameOf(zipPath)!==expectedRequest.expectedFilename)return bad(ERROR_CODES.FILENAME_MISMATCH,{details:{actual:filenameOf(zipPath),expected:expectedRequest.expectedFilename}});if(stat.size>limits.maxCompressedBytes)return bad(ERROR_CODES.COMPRESSED_SIZE_LIMIT,{details:{actual:stat.size,limit:limits.maxCompressedBytes}});
  let b;try{b=fs.readFileSync(zipPath);}catch(e){return bad(ERROR_CODES.BAD_ZIP,{details:{reason:'read',message:e.message}});}const zipHash=hash(b),parsed=parseCentral(b);if(parsed.error)return bad(ERROR_CODES.BAD_ZIP,{sha256:zipHash,details:parsed});if(parsed.entries.length===0)return bad(ERROR_CODES.EMPTY,{sha256:zipHash,details:{reason:'empty_zip'}});
  const exact=new Set(),collisions=new Map(),offsets=new Set(),items=[];
  for(const e of parsed.entries){const c=classify(e.rawName);if(!c.ok)return bad(c.code,{sha256:zipHash,details:{path:e.rawName,reason:c.reason}});const tc=typeCode(e,c);if(tc)return bad(tc,{sha256:zipHash,details:{path:e.rawName}});if(exact.has(c.structural))return bad(ERROR_CODES.DUPLICATE_PATH,{sha256:zipHash,details:{path:c.normalized}});exact.add(c.structural);const old=collisions.get(c.collisionKey);if(old!==undefined&&old!==c.structural)return bad(ERROR_CODES.CASE_COLLISION,{sha256:zipHash,details:{first:old,second:c.structural}});collisions.set(c.collisionKey,c.structural);if(offsets.has(e.localOffset))return bad(ERROR_CODES.BAD_ZIP,{sha256:zipHash,details:{reason:'duplicate_local_offset'}});offsets.add(e.localOffset);items.push({e,c});}
  if(items.length>limits.maxEntries)return bad(ERROR_CODES.ENTRY_LIMIT,{sha256:zipHash,details:{actual:items.length,limit:limits.maxEntries}});let totalU=0,totalC=0;for(const {e} of items){if(e.uncompressedSize>limits.maxEntryUncompressedBytes)return bad(ERROR_CODES.ENTRY_SIZE_LIMIT,{sha256:zipHash,details:{path:e.rawName,actual:e.uncompressedSize,limit:limits.maxEntryUncompressedBytes}});totalU+=e.uncompressedSize;totalC+=e.compressedSize;if(totalU>limits.maxTotalUncompressedBytes)return bad(ERROR_CODES.UNCOMPRESSED_SIZE_LIMIT,{sha256:zipHash,details:{actual:totalU,limit:limits.maxTotalUncompressedBytes}});if(e.uncompressedSize>0&&e.compressedSize===0)return bad(ERROR_CODES.ZIP_BOMB_RISK,{sha256:zipHash,details:{path:e.rawName,reason:'zero_compressed'}});const r=e.uncompressedSize===0?1:e.uncompressedSize/e.compressedSize;if(r>limits.maxCompressionRatio)return bad(ERROR_CODES.ZIP_BOMB_RISK,{sha256:zipHash,details:{path:e.rawName,ratio:r,limit:limits.maxCompressionRatio}});}const ar=totalU===0?1:(totalC===0?Infinity:totalU/totalC);if(ar>limits.maxCompressionRatio)return bad(ERROR_CODES.ZIP_BOMB_RISK,{sha256:zipHash,details:{aggregateRatio:ar,limit:limits.maxCompressionRatio}});
  const inventory=[],data=new Map(),ranges=[];for(const {e,c} of items){const r=entryData(b,e,parsed.centralOffset,limits.maxEntryUncompressedBytes);if(r.error)return bad(ERROR_CODES.BAD_ZIP,{sha256:zipHash,details:{path:c.normalized,...r}});ranges.push([e.localOffset,r.dataEnd,c.normalized]);data.set(c.normalized,r.data);inventory.push(Object.freeze({path:c.normalized,kind:c.isDirectory?'directory':'file',compressionMethod:e.method,compressedSize:e.compressedSize,uncompressedSize:e.uncompressedSize,sha256:c.isDirectory?'':hash(r.data)}));}ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])return bad(ERROR_CODES.BAD_ZIP,{sha256:zipHash,details:{reason:'overlap'}});
  if(!data.has('manifest.json')||inventory.find(x=>x.path==='manifest.json')?.kind!=='file')return bad(ERROR_CODES.MANIFEST_MISSING,{sha256:zipHash,inventory});const mt=utf8(data.get('manifest.json'));if(mt===null)return bad(ERROR_CODES.MANIFEST_INVALID,{sha256:zipHash,inventory,details:{reason:'manifest_utf8'}});let m;try{m=JSON.parse(mt);}catch(e){return bad(ERROR_CODES.MANIFEST_INVALID,{sha256:zipHash,inventory,details:{reason:'manifest_json',message:e.message}});}const mc=manifestCode(m);if(mc)return bad(mc,{sha256:zipHash,inventory});if(m.protocolVersion!==1)return bad(ERROR_CODES.PROTOCOL_VERSION_MISMATCH,{sha256:zipHash,inventory,details:{actual:m.protocolVersion,expected:1}});if(m.requestId!==expectedRequest.requestId)return bad(ERROR_CODES.REQUEST_MISMATCH,{sha256:zipHash,inventory});if(m.repository!==expectedRequest.repository)return bad(ERROR_CODES.REPOSITORY_MISMATCH,{sha256:zipHash,inventory});if(m.baseCommit.toLowerCase()!==expectedRequest.baseCommit.toLowerCase())return bad(ERROR_CODES.BASE_COMMIT_MISMATCH,{sha256:zipHash,inventory});
  const patchRequired=m.resultType==='patch'||m.resultType==='hybrid_patch';if(patchRequired&&!data.has('changes.patch'))return bad(ERROR_CODES.PAYLOAD_MISSING,{sha256:zipHash,inventory,details:{path:'changes.patch'}});if(!patchRequired&&data.has('changes.patch'))return bad(ERROR_CODES.MANIFEST_INVALID,{sha256:zipHash,inventory,details:{reason:'unexpected_patch'}});
  const archiveTargets=new Map();for(const p of m.files){const c=target(p);if(!c.ok)return bad(c.code,{sha256:zipHash,inventory,details:{path:p}});archiveTargets.set(`files/${c.normalized}`,c.normalized);}for(const [ap,t]of archiveTargets){const inv=inventory.find(x=>x.path===ap);if(!inv||inv.kind!=='file')return bad(ERROR_CODES.PAYLOAD_MISSING,{sha256:zipHash,inventory,details:{path:t}});}
  const roots=new Set(['manifest.json',...(patchRequired?['changes.patch']:[])]),targetPaths=new Set(archiveTargets.keys());for(const inv of inventory){if(roots.has(inv.path))continue;if(inv.path==='files/'&&inv.kind==='directory')continue;if(inv.path.startsWith('files/')){if(inv.kind==='file'&&!targetPaths.has(inv.path))return bad(ERROR_CODES.MANIFEST_INVALID,{sha256:zipHash,inventory,details:{reason:'unlisted_payload',path:inv.path}});if(inv.kind==='directory'&&![...targetPaths].some(p=>p.startsWith(inv.path)))return bad(ERROR_CODES.MANIFEST_INVALID,{sha256:zipHash,inventory,details:{reason:'orphan_directory',path:inv.path}});continue;}return bad(ERROR_CODES.SCOPE_VIOLATION,{sha256:zipHash,inventory,details:{reason:'layout',path:inv.path}});}
  for(const p of m.files){const c=target(p),sc=scopeCode(c.normalized,scopes);if(sc)return bad(sc,{sha256:zipHash,inventory,details:{path:c.normalized}});}if(patchRequired){const pt=utf8(data.get('changes.patch'));if(pt===null)return bad(ERROR_CODES.PATCH_INVALID,{sha256:zipHash,inventory,details:{reason:'patch_utf8'}});const pc=validateDiff(pt,scopes);if(pc)return bad(pc,{sha256:zipHash,inventory});}
  return good(zipHash,m,inventory);
}
