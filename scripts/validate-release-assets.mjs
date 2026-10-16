#!/usr/bin/env node
/**
 * G1Viewer — Release & CI Package Deliverable Validator
 *
 * Enforces strict delivery rules:
 *  1. Every supported OS/architecture produces its own individual installer/package.
 *  2. No ZIP archives are used or published in place of native installers.
 *  3. Binary headers, formats, minimum sizes, and non-empty status are verified.
 *  4. In aggregate mode, ensures all 6 deliverables exist before release publication.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXPECTED_DELIVERABLES = {
  'windows-x64': {
    filename: 'g1viewer_x64.exe',
    platform: 'win32',
    arch: 'x64',
    ext: '.exe',
    minBytes: 30 * 1024 * 1024,
    checkMagic: (head) => head[0] === 0x4d && head[1] === 0x5a, // MZ (PE executable)
    desc: 'Windows x64 NSIS standalone installer'
  },
  'windows-arm64': {
    filename: 'g1viewer_arm64.exe',
    platform: 'win32',
    arch: 'arm64',
    ext: '.exe',
    minBytes: 30 * 1024 * 1024,
    checkMagic: (head) => head[0] === 0x4d && head[1] === 0x5a, // MZ (PE executable)
    desc: 'Windows ARM64 NSIS standalone installer'
  },
  'macos-x64': {
    filename: 'g1viewer_x64.dmg',
    platform: 'darwin',
    arch: 'x64',
    ext: '.dmg',
    minBytes: 50 * 1024 * 1024,
    checkMagic: (head, tail) => tail.includes('koly') || (head[0] === 0x78 && head[1] === 0xda), // UDIF koly trailer / zlib
    desc: 'macOS Intel x64 standalone disk image'
  },
  'macos-arm64': {
    filename: 'g1viewer_arm64.dmg',
    platform: 'darwin',
    arch: 'arm64',
    ext: '.dmg',
    minBytes: 50 * 1024 * 1024,
    checkMagic: (head, tail) => tail.includes('koly') || (head[0] === 0x78 && head[1] === 0xda), // UDIF koly trailer / zlib
    desc: 'macOS Apple Silicon ARM64 standalone disk image'
  },
  'linux-x64-deb': {
    filename: 'g1viewer_x64.deb',
    platform: 'linux',
    arch: 'x64',
    ext: '.deb',
    minBytes: 25 * 1024 * 1024,
    checkMagic: (head) => head.toString('ascii', 0, 7) === '!<arch>', // Debian ar archive
    desc: 'Linux Debian / Ubuntu standalone package (.deb)'
  },
  'linux-x64-appimage': {
    filename: 'g1viewer_x64.AppImage',
    platform: 'linux',
    arch: 'x64',
    ext: '.AppImage',
    minBytes: 25 * 1024 * 1024,
    checkMagic: (head) => head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46, // ELF binary
    desc: 'Linux x64 standalone executable package (.AppImage)'
  }
};

function readMagicBuffers(filePath, stat) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(64, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);

    const tailLen = Math.min(1024, stat.size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, Math.max(0, stat.size - tailLen));

    return { head, tail };
  } finally {
    fs.closeSync(fd);
  }
}

function calculateSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

export function validateSingleDeliverable(targetId, targetDir = 'release') {
  const spec = EXPECTED_DELIVERABLES[targetId];
  if (!spec) {
    throw new Error(`Unknown target ID "${targetId}". Valid IDs: ${Object.keys(EXPECTED_DELIVERABLES).join(', ')}`);
  }

  const fullPath = path.resolve(targetDir, spec.filename);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing expected standalone deliverable for ${targetId}: "${fullPath}" does not exist.`);
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    throw new Error(`Invalid deliverable: "${fullPath}" is a directory, expected a compiled standalone file.`);
  }

  if (stat.size === 0) {
    throw new Error(`Invalid deliverable: "${fullPath}" is 0 bytes (empty).`);
  }

  if (stat.size < spec.minBytes) {
    throw new Error(`Invalid deliverable: "${fullPath}" is only ${(stat.size / 1024 / 1024).toFixed(2)} MB, below minimum expected ${(spec.minBytes / 1024 / 1024).toFixed(2)} MB.`);
  }

  const { head, tail } = readMagicBuffers(fullPath, stat);

  // Reject ZIP archives disguised as installers
  if ((head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) || fullPath.endsWith('.zip')) {
    throw new Error(`Prohibited format: "${fullPath}" is a ZIP archive! Standalone platform installers must not be packaged inside ZIPs.`);
  }

  if (spec.checkMagic && !spec.checkMagic(head, tail)) {
    throw new Error(`Binary format mismatch for "${spec.filename}": failed magic byte inspection for ${spec.desc}.`);
  }

  const sha256 = calculateSha256(fullPath);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

  console.log(`✅ [${targetId}] Validated standalone deliverable:`);
  console.log(`   File:   ${spec.filename}`);
  console.log(`   Path:   ${fullPath}`);
  console.log(`   Size:   ${sizeMb} MB (${stat.size} bytes)`);
  console.log(`   SHA256: ${sha256}`);
  console.log(`   Type:   ${spec.desc}\n`);

  return { targetId, spec, fullPath, stat, sha256 };
}

export function validateAllDeliverables(targetDir = 'release-assets') {
  const dirPath = path.resolve(targetDir);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Release directory does not exist: "${dirPath}"`);
  }

  console.log(`\n🔍 Validating all 6 standalone platform deliverables in: ${dirPath}`);

  const results = [];
  const errors = [];

  for (const [targetId] of Object.entries(EXPECTED_DELIVERABLES)) {
    try {
      const res = validateSingleDeliverable(targetId, dirPath);
      results.push(res);
    } catch (err) {
      errors.push(err.message);
    }
  }

  // Check for any forbidden ZIP archives or stray blockmaps in the release assets directory
  const entries = fs.readdirSync(dirPath);
  for (const file of entries) {
    if (file.endsWith('.zip')) {
      errors.push(`Prohibited asset found in release directory: "${file}". No ZIP packages are permitted in releases.`);
    }
    if (file.includes('.blockmap') || file.endsWith('.yml') || file.endsWith('.yaml')) {
      errors.push(`Unwanted internal builder asset found in release directory: "${file}". Clean this up before publishing.`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ Validation FAILED with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`   - ${err}`);
    }
    throw new Error(`Release validation failed. Missing or invalid deliverables.`);
  }

  // Generate SHA256SUMS.txt
  const checksumLines = results.map(r => `${r.sha256}  ${r.spec.filename}`);
  const checksumPath = path.join(dirPath, 'SHA256SUMS.txt');
  fs.writeFileSync(checksumPath, checksumLines.join('\n') + '\n', 'utf8');

  console.log(`📝 Generated ${checksumPath} containing verified checksums for all 6 packages.\n`);
  console.log(`🎉 SUCCESS: All 6 standalone platform installers verified with ZERO ZIP wrappers!`);
  return results;
}

// CLI invocation handling
const args = process.argv.slice(2);
if (args.includes('--all')) {
  const dirIdx = args.indexOf('--all') + 1;
  const dir = (dirIdx < args.length && !args[dirIdx].startsWith('--')) ? args[dirIdx] : 'release-assets';
  try {
    validateAllDeliverables(dir);
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (args.includes('--target')) {
  const targetIdx = args.indexOf('--target') + 1;
  const target = args[targetIdx];
  const dirIdx = args.indexOf('--dir') + 1;
  const dir = (dirIdx > 0 && dirIdx < args.length && !args[dirIdx].startsWith('--')) ? args[dirIdx] : 'release';
  try {
    validateSingleDeliverable(target, dir);
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else {
  console.log('Usage:');
  console.log('  node scripts/validate-release-assets.mjs --target <target-id> [--dir <dir>]');
  console.log('  node scripts/validate-release-assets.mjs --all [<dir>]');
  console.log('\nValid Target IDs:');
  for (const [id, spec] of Object.entries(EXPECTED_DELIVERABLES)) {
    console.log(`  - ${id.padEnd(20)} -> ${spec.filename} (${spec.desc})`);
  }
  process.exit(1);
}
