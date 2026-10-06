// [knauf] KK20-397 — which code-execution outputs never become user attachments.
//
// `processCodeOutput` turns every file a run captured into a chat attachment. Two kinds
// must not be:
//
//  1. Visual-QA renders. The Office/PDF skills render pages and slides to contact sheets
//     under `/mnt/data/_karl_qa/` so the model can look at them (packages/api
//     knauf/code/visualQa.ts). They are working material: attaching them would clutter the
//     chat, and every attachment is re-sent into every later run of the conversation.
//  2. Verbatim copies of sandbox-only skill files and plain font files. The Knauf fonts ship
//     in a deployment skill's `sandbox/` folder, hidden from the Skills API (packages/api
//     knauf/skills/sandboxOnlySkillFiles.ts), and this stops the casual route back out:
//     "copy the font to /mnt/data", or a zip of it. Fonts EMBEDDED in a generated PDF or
//     DOCX are untouched — that is the intended use.
//
// THIS IS NOT A CONFIDENTIALITY BOUNDARY. Anything mounted in the sandbox is readable by
// code the user can steer, and that code can re-encode it (an archive under another name,
// tar or gzip, base64 in a text file) past any output filter. Only put in a `sandbox/`
// folder what users may be able to obtain: the Knauf fonts ship there only once the licence
// is confirmed to allow that (knauf/brand/README.md). Bytes that must stay secret cannot be
// mounted for user code at all.
//
// Deliberately dependency-free (no `@librechat/api`): several process.js specs mock that
// package with a fixed key list, and a new key would be undefined there.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Reserved sandbox folder for visual-QA renders (never hidden from capture, never attached). */
const PRIVATE_QA_PREFIX = '_karl_qa/';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2', '.eot']);

/**
 * Leading bytes of the font containers we block (TrueType, OpenType, collections, WOFF).
 * The Mac `true` tag is left to the extension check: as a magic it would match a text file
 * that merely starts with the word.
 */
const FONT_MAGIC = [
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
  Buffer.from('OTTO', 'latin1'),
  Buffer.from('ttcf', 'latin1'),
  Buffer.from('wOFF', 'latin1'),
  Buffer.from('wOF2', 'latin1'),
];

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;
const ZIP_EOCD_MAX_SCAN = 22 + 0xffff;

function isPrivateQaRender(name) {
  return (
    typeof name === 'string' && name.replace(/^\/mnt\/data\//, '').startsWith(PRIVATE_QA_PREFIX)
  );
}

function hasFontExtension(name) {
  return FONT_EXTENSIONS.has(path.extname(String(name)).toLowerCase());
}

/** A font's table directory is binary; requiring a NUL keeps `OTTO…` text files out. */
function looksLikeFont(buffer) {
  return (
    buffer.subarray(0, 64).includes(0) &&
    FONT_MAGIC.some(
      (magic) => buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic),
    )
  );
}

/**
 * Entry names from a zip's central directory, or null when the buffer is not a readable
 * zip. Bounded: at most `maxEntries` names, and never reads outside the buffer.
 */
function zipEntryNames(buffer, maxEntries = 10000) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    return null;
  }
  const scanFrom = Math.max(0, buffer.length - ZIP_EOCD_MAX_SCAN);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_END_OF_CENTRAL_DIR) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return null;
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < Math.min(count, maxEntries); n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      break;
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength > buffer.length) {
      break;
    }
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function skillsDirectory() {
  const configured = process.env.DEPLOYMENT_SKILLS_DIR?.trim();
  const repoRoot = path.resolve(__dirname, '../../../../..');
  if (!configured) {
    return path.join(repoRoot, 'skill');
  }
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

let restrictedHashes = null;

/** SHA-256 of every file under `skill/<name>/sandbox/`, computed once, lazily. */
function sandboxAssetHashes() {
  if (restrictedHashes != null) {
    return restrictedHashes;
  }
  const hashes = new Set();
  const root = skillsDirectory();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        hashes.add(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  };
  try {
    for (const skill of fs.readdirSync(root, { withFileTypes: true })) {
      const sandbox = path.join(root, skill.name, 'sandbox');
      if (skill.isDirectory() && fs.existsSync(sandbox)) {
        walk(sandbox);
      }
    }
  } catch {
    // No skills directory (tests, stripped images): nothing to match against.
  }
  restrictedHashes = hashes;
  return hashes;
}

/**
 * Why this code output must not be delivered, or null when it may be.
 * @param {{ name: string, buffer: Buffer }} output
 * @returns {'font' | 'restricted_asset' | 'font_archive' | null}
 */
function blockedCodeOutputReason({ name, buffer }) {
  if (hasFontExtension(name) || looksLikeFont(buffer)) {
    return 'font';
  }
  if (sandboxAssetHashes().has(crypto.createHash('sha256').update(buffer).digest('hex'))) {
    return 'restricted_asset';
  }
  const entries = zipEntryNames(buffer);
  if (entries != null && entries.some(hasFontExtension)) {
    return 'font_archive';
  }
  return null;
}

/** Test seam. */
function resetCodeOutputPolicyCache() {
  restrictedHashes = null;
}

module.exports = {
  PRIVATE_QA_PREFIX,
  isPrivateQaRender,
  blockedCodeOutputReason,
  zipEntryNames,
  resetCodeOutputPolicyCache,
};
