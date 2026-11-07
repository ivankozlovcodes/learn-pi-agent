#!/usr/bin/env node
// Structural parity between a Chinese source markdown file and its English translation.
//
// Usage:
//   node translation/check-parity.mjs [--require-all] [file-or-chapter-dir ...]
//   node translation/check-parity.mjs --pair source.md translation.en.md
//   node translation/check-parity.mjs --self-test
//
// Default pairs: every chapters/*/README.md with an existing chapters/*/README.en.md.
// Sources without an English file are reported as MISSING (a failure only with --require-all).
// Exits 1 on any FAIL, else 0.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAN = /\p{Script=Han}/u;
const MAX_SNIPPET = 60;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chaptersDir = path.join(repoRoot, 'chapters');
const fixturesDir = path.join(repoRoot, 'translation', 'fixtures', 'parity');

function relative(file) {
  return path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');
}

function snippet(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET - 1)}…` : trimmed;
}

// Count links and images on a line outside fences, ignoring inline code spans.
function countLinksAndImages(line) {
  const withoutCode = line.replace(/`[^`]*`/g, '');
  let links = 0;
  let images = 0;
  for (const match of withoutCode.matchAll(/(!?)\[[^\]]*\]\([^)]*\)/g)) {
    if (match[1] === '!') images += 1;
    else links += 1;
  }
  return { links, images };
}

// Parse markdown into the structural features compared by checkPair.
function parseMarkdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const doc = {
    frontMatter: false,
    headings: [0, 0, 0, 0, 0, 0],
    tables: [], // row count per table, in order
    images: 0,
    links: 0,
    blockquotes: 0,
    containers: 0,
    fences: [], // { lang, body: string[] }
  };

  let index = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      doc.frontMatter = true;
      index = end + 1;
    }
  }

  let openFence = null; // { char, length, fence }
  let tableRows = 0;
  const closeTable = () => {
    if (tableRows > 0) doc.tables.push(tableRows);
    tableRows = 0;
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];

    if (openFence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === openFence.char && close[1].length >= openFence.length) {
        openFence = null;
      } else {
        openFence.fence.body.push(line);
      }
      continue;
    }

    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      closeTable();
      const fence = { lang: open[2].trim().split(/\s+/)[0] || '', body: [] };
      doc.fences.push(fence);
      openFence = { char: open[1][0], length: open[1].length, fence };
      continue;
    }

    if (/^\s*\|/.test(line)) {
      tableRows += 1;
    } else {
      closeTable();
    }

    const heading = line.match(/^ {0,3}(#{1,6})(\s|$)/);
    if (heading) doc.headings[heading[1].length - 1] += 1;
    if (/^\s*>/.test(line)) doc.blockquotes += 1;
    if (/^:::\s/.test(line)) doc.containers += 1;

    const { links, images } = countLinksAndImages(line);
    doc.links += links;
    doc.images += images;
  }
  closeTable();
  return doc;
}

function mermaidCount(doc) {
  return doc.fences.filter((fence) => fence.lang === 'mermaid').length;
}

// Compare two parsed documents; returns a list of human-readable failure reasons.
function compareDocs(src, en) {
  const reasons = [];
  const compareCount = (label, a, b) => {
    if (a !== b) reasons.push(`${label}: ${a} vs ${b}`);
  };

  if (src.frontMatter !== en.frontMatter) {
    reasons.push(`front matter: ${src.frontMatter ? 'present' : 'absent'} vs ${en.frontMatter ? 'present' : 'absent'}`);
  }
  src.headings.forEach((count, level) => compareCount(`h${level + 1}`, count, en.headings[level]));

  compareCount('tables', src.tables.length, en.tables.length);
  const sharedTables = Math.min(src.tables.length, en.tables.length);
  for (let t = 0; t < sharedTables; t += 1) {
    compareCount(`table #${t + 1} rows`, src.tables[t], en.tables[t]);
  }

  compareCount('images', src.images, en.images);
  compareCount('links', src.links, en.links);
  compareCount('blockquote lines', src.blockquotes, en.blockquotes);
  compareCount('::: containers', src.containers, en.containers);
  compareCount('fences', src.fences.length, en.fences.length);
  compareCount('mermaid fences', mermaidCount(src), mermaidCount(en));

  const sharedFences = Math.min(src.fences.length, en.fences.length);
  for (let f = 0; f < sharedFences; f += 1) {
    const a = src.fences[f];
    const b = en.fences[f];
    const label = `fence #${f + 1} (${a.lang || 'plain'})`;
    if (a.lang !== b.lang) {
      reasons.push(`${label} lang: ${a.lang || 'plain'} vs ${b.lang || 'plain'}`);
      continue;
    }
    if (a.body.length !== b.body.length) {
      reasons.push(`${label} body lines: ${a.body.length} vs ${b.body.length}`);
      continue;
    }
    a.body.forEach((srcLine, i) => {
      const enLine = b.body[i];
      if (HAN.test(enLine)) {
        reasons.push(`${label} line ${i + 1} still has Chinese: ${snippet(enLine)}`);
      } else if (!HAN.test(srcLine) && srcLine.trimEnd() !== enLine.trimEnd()) {
        reasons.push(`${label} line ${i + 1} differs: ${snippet(srcLine)} | ${snippet(enLine)}`);
      }
    });
  }
  return reasons;
}

function checkPair(srcFile, enFile) {
  const src = parseMarkdown(readFileSync(srcFile, 'utf8'));
  const en = parseMarkdown(readFileSync(enFile, 'utf8'));
  const reasons = compareDocs(src, en);
  return { srcFile, enFile, src, en, reasons, ok: reasons.length === 0 };
}

function englishPathFor(srcFile) {
  return srcFile.replace(/\.md$/, '.en.md');
}

function listChapterSources() {
  if (!existsSync(chaptersDir)) return [];
  return readdirSync(chaptersDir)
    .sort()
    .map((name) => path.join(chaptersDir, name, 'README.md'))
    .filter((file) => existsSync(file));
}

// Map a CLI arg (source file, English file, or chapter dir) to a source file.
function sourceForArg(arg) {
  const absolute = path.resolve(arg);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) return path.join(absolute, 'README.md');
  if (absolute.endsWith('.en.md')) return absolute.replace(/\.en\.md$/, '.md');
  return absolute;
}

function cell(a, b) {
  return a === b ? String(a) : `${a}≠${b}`;
}

function printTable(results) {
  const header = ['file', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tables', 'fences', 'mermaid', 'images', 'links', 'result'];
  const rows = results.map((result) => {
    if (result.missing) {
      return [relative(result.srcFile), '', '', '', '', '', '', '', '', '', '', '', 'MISSING'];
    }
    const { src, en } = result;
    return [
      relative(result.enFile),
      ...src.headings.map((count, level) => cell(count, en.headings[level])),
      cell(src.tables.length, en.tables.length),
      cell(src.fences.length, en.fences.length),
      cell(mermaidCount(src), mermaidCount(en)),
      cell(src.images, en.images),
      cell(src.links, en.links),
      result.ok ? 'OK' : 'FAIL',
    ];
  });
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const format = (row) => row.map((value, column) => value.padEnd(widths[column])).join('  ').trimEnd();
  console.log(format(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(format(row));

  for (const result of results) {
    if (result.missing || result.ok) continue;
    console.log(`\nFAIL ${relative(result.enFile)} (source ${relative(result.srcFile)}):`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
  }
}

function runSelfTest() {
  const sample = path.join(fixturesDir, 'sample.md');
  const good = checkPair(sample, path.join(fixturesDir, 'sample.en.md'));
  const bad = checkPair(sample, path.join(fixturesDir, 'sample.bad.en.md'));
  printTable([good, bad]);
  console.log('');

  const expectations = [
    ['sample.en.md passes', good.ok],
    ['sample.bad.en.md fails', !bad.ok],
    ['bad: missing h2 detected', bad.reasons.some((r) => r.startsWith('h2:'))],
    ['bad: changed fence code line detected', bad.reasons.some((r) => /^fence #\d+ .* line \d+ differs:/.test(r))],
    ['bad: dropped link detected', bad.reasons.some((r) => r.startsWith('links:'))],
    ['sample has front matter, table, mermaid, image, link, blockquote',
      good.src.frontMatter && good.src.tables.length > 0 && mermaidCount(good.src) > 0 &&
      good.src.images > 0 && good.src.links > 0 && good.src.blockquotes > 0],
  ];
  let failed = 0;
  for (const [label, passed] of expectations) {
    console.log(`${passed ? '✓' : '✗'} ${label}`);
    if (!passed) failed += 1;
  }
  console.log(failed === 0 ? '\nself-test passed' : `\nself-test FAILED (${failed} expectation(s))`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest();

  const pairIndex = args.indexOf('--pair');
  if (pairIndex !== -1) {
    const [srcFile, enFile] = args.slice(pairIndex + 1, pairIndex + 3);
    if (!srcFile || !enFile) {
      console.error('usage: check-parity.mjs --pair <source.md> <translation.md>');
      return 2;
    }
    const result = checkPair(path.resolve(srcFile), path.resolve(enFile));
    printTable([result]);
    return result.ok ? 0 : 1;
  }

  const requireAll = args.includes('--require-all');
  const filters = args.filter((arg) => !arg.startsWith('--'));
  const sources = filters.length > 0 ? [...new Set(filters.map(sourceForArg))] : listChapterSources();

  const results = [];
  for (const srcFile of sources) {
    if (!existsSync(srcFile)) {
      console.error(`no such source file: ${relative(srcFile)}`);
      return 2;
    }
    const enFile = englishPathFor(srcFile);
    if (!existsSync(enFile)) results.push({ srcFile, enFile, missing: true });
    else results.push(checkPair(srcFile, enFile));
  }

  if (results.length === 0) {
    console.log('no source files found');
    return 0;
  }
  printTable(results);

  const failures = results.filter((result) => !result.missing && !result.ok).length;
  const missing = results.filter((result) => result.missing).length;
  const checked = results.length - missing;
  console.log(`\n${checked} checked, ${failures} failed, ${missing} missing${requireAll ? ' (--require-all)' : ''}`);
  return failures > 0 || (requireAll && missing > 0) ? 1 : 0;
}

process.exitCode = main();
