#!/usr/bin/env bun
/**
 * #5575 (ENG-16) regex-safety lint for the write gate detector.
 *
 * Every pattern in `WRITE_GATE_PATTERNS` (src/core/write-gate-patterns.ts)
 * must be safe to run on attacker-controlled text of any size:
 *   - no unbounded quantifier (`*`, `+`, `{n,}`) and no bound above 200,
 *   - no repeated group that itself contains a repeat (nested quantifiers),
 *   - no backreference,
 *   - a longest possible match of at most MAX_MATCH_CHARS, and a `preceded`
 *     context of at most MAX_PRECEDING_CHARS (together the window overlap,
 *     so a match straddling two scan windows is still found),
 *   - non-global and non-sticky (`.test()` keeps no state), with at least one
 *     lowercase prefilter anchor.
 *
 * Usage: bun scripts/check-write-gate-regex.ts   (exit 0 clean, 1 on violations)
 * Self-test seam: with GBRAIN_GUARD_ROOT set, the guard checks the patterns
 * listed in <root>/patterns.json ({ name, source, flags, anchors, preceded? }
 * objects) instead of the real table (scripts/guard-self-test.sh fixtures).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_MATCH_CHARS, MAX_PRECEDING_CHARS, WRITE_GATE_PATTERNS, type WriteGatePattern } from '../src/core/write-gate-patterns.ts';

export const MAX_QUANTIFIER_BOUND = 200;

interface Node { max: number; repeats: boolean }

/** Static analysis of one regex source: its longest match and every safety violation. */
export function analyzeRegexSource(source: string): { maxLength: number; errors: string[] } {
  const errors: string[] = [];
  let pos = 0;

  const atomWidth = (): Node & { group: boolean } => {
    const ch = source[pos]!;
    if (ch === '\\') {
      const next = source[pos + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') errors.push(`backreference at ${pos}`);
      if (next === 'u' && source[pos + 2] === '{') { pos = source.indexOf('}', pos) + 1; return { max: 1, repeats: false, group: false }; }
      const len = next === 'u' ? 6 : next === 'x' ? 4 : next === 'c' ? 3 : 2;
      pos += len;
      return { max: next === 'b' || next === 'B' ? 0 : 1, repeats: false, group: false };
    }
    if (ch === '[') {
      pos++;
      while (pos < source.length && source[pos] !== ']') pos += source[pos] === '\\' ? 2 : 1;
      pos++;
      return { max: 1, repeats: false, group: false };
    }
    if (ch === '(') {
      pos++;
      let lookaround = false;
      if (source[pos] === '?') {
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(pos));
        if (!m) { errors.push(`unsupported group syntax at ${pos}`); return { max: 0, repeats: false, group: true }; }
        lookaround = ['?=', '?!', '?<=', '?<!'].includes(m[0]);
        pos += m[0].length;
      }
      const inner = alternation();
      if (source[pos] !== ')') errors.push(`unclosed group at ${pos}`);
      pos++;
      return { max: lookaround ? 0 : inner.max, repeats: inner.repeats, group: true };
    }
    if (ch === '^' || ch === '$') { pos++; return { max: 0, repeats: false, group: false }; }
    pos++;
    return { max: 1, repeats: false, group: false };
  };

  const quantifier = (): { lo: number; hi: number } | null => {
    const ch = source[pos];
    let q: { lo: number; hi: number } | null = null;
    if (ch === '?') { q = { lo: 0, hi: 1 }; pos++; }
    else if (ch === '*') { q = { lo: 0, hi: Infinity }; pos++; }
    else if (ch === '+') { q = { lo: 1, hi: Infinity }; pos++; }
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(pos));
      if (!m) return null;
      q = { lo: Number(m[1]), hi: m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]) };
      pos += m[0].length;
    }
    if (q && source[pos] === '?') pos++;
    return q;
  };

  const sequence = (): Node => {
    let max = 0;
    let repeats = false;
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      const start = pos;
      const atom = atomWidth();
      const q = quantifier();
      if (!q) { max += atom.max; repeats ||= atom.repeats; continue; }
      if (q.hi === Infinity) errors.push(`unbounded quantifier after "${source.slice(start, pos)}"`);
      else if (q.hi > MAX_QUANTIFIER_BOUND) errors.push(`quantifier bound ${q.hi} over ${MAX_QUANTIFIER_BOUND} after "${source.slice(start, pos)}"`);
      if (atom.group && atom.repeats && q.hi > 1) errors.push(`nested quantifier in "${source.slice(start, pos)}"`);
      const hi = Number.isFinite(q.hi) ? q.hi : MAX_QUANTIFIER_BOUND;
      max += atom.max * hi;
      repeats ||= atom.repeats || q.hi > 1;
    }
    return { max, repeats };
  };

  function alternation(): Node {
    let node = sequence();
    while (source[pos] === '|') {
      pos++;
      const next = sequence();
      node = { max: Math.max(node.max, next.max), repeats: node.repeats || next.repeats };
    }
    return node;
  }

  const root = alternation();
  if (pos < source.length) errors.push(`unbalanced ")" at ${pos}`);
  return { maxLength: root.max, errors };
}

export function checkWriteGatePatterns(patterns: readonly WriteGatePattern[] = WRITE_GATE_PATTERNS): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const p of patterns) {
    if (names.has(p.name)) problems.push(`${p.name}: duplicate pattern name`);
    names.add(p.name);
    if (p.rx.global || p.rx.sticky) problems.push(`${p.name}: global or sticky flag (stateful .test())`);
    if (!p.anchors.length || p.anchors.some(a => !a || a !== a.toLowerCase())) problems.push(`${p.name}: needs non-empty lowercase prefilter anchors`);
    const { maxLength, errors } = analyzeRegexSource(p.rx.source);
    for (const e of errors) problems.push(`${p.name}: ${e}`);
    if (maxLength > MAX_MATCH_CHARS) problems.push(`${p.name}: longest match ${maxLength} chars exceeds MAX_MATCH_CHARS ${MAX_MATCH_CHARS}`);
    if (p.preceded) {
      if (p.preceded.global || p.preceded.sticky) problems.push(`${p.name}: preceded regex is global or sticky`);
      if (!p.preceded.source.endsWith('$')) problems.push(`${p.name}: preceded regex must end with $ (it checks the text right before the match)`);
      const ctx = analyzeRegexSource(p.preceded.source);
      for (const e of ctx.errors) problems.push(`${p.name} (preceded): ${e}`);
      if (ctx.maxLength > MAX_PRECEDING_CHARS) problems.push(`${p.name}: preceded context ${ctx.maxLength} chars exceeds MAX_PRECEDING_CHARS ${MAX_PRECEDING_CHARS}`);
    }
  }
  return problems;
}

function fixturePatterns(root: string): WriteGatePattern[] {
  const rows = JSON.parse(readFileSync(join(root, 'patterns.json'), 'utf8')) as Array<{ name: string; source: string; flags?: string; anchors: string[]; preceded?: string }>;
  return rows.map(r => ({ name: r.name, family: 'override', rx: new RegExp(r.source, r.flags ?? 'i'), anchors: r.anchors, ...(r.preceded ? { preceded: new RegExp(r.preceded, 'i') } : {}) }));
}

if (import.meta.main) {
  const root = process.env.GBRAIN_GUARD_ROOT;
  const problems = checkWriteGatePatterns(root ? fixturePatterns(root) : WRITE_GATE_PATTERNS);
  if (problems.length) {
    console.error(`write-gate regex safety: ${problems.length} violation(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`write-gate regex safety: ${WRITE_GATE_PATTERNS.length} patterns bounded (max match <= ${MAX_MATCH_CHARS} chars).`);
}
