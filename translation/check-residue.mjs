#!/usr/bin/env node
// Find leftover Chinese (\p{Han}) in files that should be English.
//
// Usage:
//   node translation/check-residue.mjs [--summary] [path-or-glob ...]
//
// Scans `git ls-files -co --exclude-standard`, minus binary files, lockfiles,
// build/cache directories, and globs listed in translation/residue-allowlist.txt.
// Exits 1 when any Han character is found, else 0.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Han characters, plus CJK/full-width punctuation that should be ASCII in English text.
const HAN = /[\p{Script=Han}\u3000-\u303F\uFF01-\uFF1F\uFF3B-\uFF40\uFF5B-\uFF65]/u;
const MAX_LINE = 120;
const SKIPPED_DIR_PREFIXES = ['node_modules/', 'dist/', 'website/.vitepress/cache/', 'website/.vitepress/dist/'];
const SKIPPED_DIR_SEGMENTS = ['/node_modules/', '/dist/', '/.vitepress/cache/', '/.vitepress/dist/'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(repoRoot, 'translation', 'residue-allowlist.txt');

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Allowlist lines are file globs, or `text:<literal>` entries whose literal is
// removed from every line before the Han test (e.g. the "简体中文" switcher label).
function readAllowlist() {
  const entries = readFileSync(allowlistPath, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return {
    globs: entries.filter((e) => !e.startsWith('text:')),
    texts: entries.filter((e) => e.startsWith('text:')).map((e) => e.slice(5)),
  };
}

function stripAllowedText(line, texts) {
  return texts.reduce((acc, t) => acc.split(t).join(''), line);
}

function matchesAny(file, globs) {
  return globs.some((glob) => path.posix.matchesGlob(file, glob));
}

function isSkippedPath(file) {
  if (path.posix.basename(file) === 'package-lock.json') return true;
  if (SKIPPED_DIR_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
  const padded = `/${file}`;
  return SKIPPED_DIR_SEGMENTS.some((segment) => padded.includes(segment));
}

// Treat a file as binary if its first 8 KiB contains a NUL byte.
function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

// A CLI arg restricts the scan if it equals the file, is a directory prefix of it,
// or is a glob matching it.
function matchesArg(file, arg) {
  const normalized = toPosix(arg).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return true;
  if (file === normalized || file.startsWith(`${normalized}/`)) return true;
  return path.posix.matchesGlob(file, normalized);
}

function listFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

function truncate(text) {
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
}

function main() {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes('--summary');
  const filters = args.filter((arg) => !arg.startsWith('--'));
  const { globs: allowlist, texts: allowedTexts } = readAllowlist();

  let scanned = 0;
  let totalHitLines = 0;
  const hitsPerFile = [];

  for (const file of listFiles()) {
    if (isSkippedPath(file)) continue;
    if (filters.length > 0 && !filters.some((arg) => matchesArg(file, arg))) continue;
    if (matchesAny(file, allowlist)) continue;

    const absolute = path.join(repoRoot, file);
    let buffer;
    try {
      if (!statSync(absolute).isFile()) continue;
      buffer = readFileSync(absolute);
    } catch {
      continue; // deleted from the worktree but still tracked
    }
    if (isBinary(buffer)) continue;
    scanned += 1;

    const lines = buffer.toString('utf8').split('\n');
    let fileHits = 0;
    lines.forEach((line, index) => {
      if (!HAN.test(stripAllowedText(line, allowedTexts))) return;
      fileHits += 1;
      if (!summaryOnly) console.log(`${file}:${index + 1}: ${truncate(line.trim())}`);
    });
    if (fileHits > 0) {
      hitsPerFile.push([file, fileHits]);
      totalHitLines += fileHits;
    }
  }

  if (hitsPerFile.length === 0) {
    console.log(`✓ no residue (${scanned} files scanned)`);
    return 0;
  }

  if (summaryOnly) {
    for (const [file, count] of hitsPerFile) console.log(`${String(count).padStart(5)}  ${file}`);
  } else {
    console.log('');
  }
  console.log(`✗ residue: ${hitsPerFile.length} files with hits, ${totalHitLines} hit lines (${scanned} files scanned)`);
  return 1;
}

process.exitCode = main();
