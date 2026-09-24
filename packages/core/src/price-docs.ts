import { builtInCacheReadMult, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT } from "./pricing.ts";
import type { FastRates, PriceSpec } from "./types.ts";

/**
 * Parser for Anthropic's published pricing table, so a newly-released model can be
 * priced without a code change. Pure — the network fetch lives in the daemon.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing.md
 * (the `.md` suffix matters — the bare URL serves a ~1MB SPA shell with no table).
 *
 * Three hazards this parser exists to handle:
 *
 *  1. THREE tables on that page carry "$N / MTok" cells. Opus 5 appears at $5/$25
 *     (base), $10/$50 (fast mode), and $2.50/$12.50 (batch). Billing a dashboard at
 *     fast-mode rates would be a silent 2x overstatement. The model table is the only
 *     one with SIX columns (model, base in, 5m write, 1h write, cache hit, out), so we
 *     require exactly that shape and reject the 3-column tables outright.
 *
 *  2. A row could still be misread. The published cache columns are a derived check:
 *     they must equal base x {1.25, 2, 0.1}, or the model's own read multiplier where
 *     the built-in table records one (Opus 5.5: 0.05x). A mismatch means either we misparsed or
 *     Anthropic changed the multipliers — both are reasons to refuse the row, and the
 *     latter is reported separately because it makes ccc's own constants stale.
 *
 *  3. Display names are not model ids ("Claude Opus 4.8" vs "claude-opus-4-8"), and
 *     rows carry qualifier text ("(deprecated)", "through August 31, 2026").
 *
 *  4. Price cells carry footnote markers ("$0.20 / MTok<sup>2</sup>"). The row-shape check
 *     treats an unparseable cell as "not a price table", so an unstripped marker drops the
 *     row without a word: that hid Opus 5.5, Fable 5.1, Mythos 5.1 and Sonnet 5.
 */

/** Half-a-cent absolute plus a hair of relative slack — published figures are cent-rounded. */
function approxEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 0.01 + expected * 0.001;
}

export interface ParsedPriceRow {
  modelId: string;
  displayName: string;
  inputPerM: number;
  outputPerM: number;
  /** Premium fast-mode rates, when the page's fast-mode table lists this model. */
  fast?: FastRates;
}

export interface PriceDocParse {
  /** Rows that passed every check, in document order. */
  rows: ParsedPriceRow[];
  /**
   * Model ids whose published cache columns did NOT match base x our multipliers.
   * Non-empty means CACHE_WRITE_5M_MULT / _1H_MULT, or the read multiplier ccc has for
   * that model (CACHE_READ_MULT unless its table entry sets cacheReadMult), may be stale —
   * surfaced by `ccc doctor` rather than silently dropped.
   */
  multiplierMismatch: string[];
  /** Ids seen more than once (e.g. an intro-pricing row plus its successor). First wins. */
  duplicates: string[];
  /** Six-column candidate rows rejected for any other reason (unparseable name, bad bounds). */
  rejected: number;
}

const PRICE_CELL = /^\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok$/i;

/** Footnote markers: HTML superscripts and markdown footnote refs ("[^2]"). */
function stripFootnotes(s: string): string {
  return s.replace(/<sup>[^<]*<\/sup>/gi, "").replace(/\[\^[^\]]*\]/g, "");
}

function parsePriceCell(cell: string): number | null {
  const m = stripFootnotes(cell).trim().match(PRICE_CELL);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Claude Opus 4.8" -> "claude-opus-4-8". Returns null when the cell isn't a model
 * name (header rows, the "Model" label, prose). Strips markdown links and the
 * qualifier tails the table uses for deprecation and dated pricing windows.
 */
/**
 * Reduce a docs cell to plain text: unwrap markdown links to their label, then drop
 * parentheticals.
 *
 * Links must be UNWRAPPED, not dropped: on the prompt-caching page the model name itself
 * is sometimes the link label ("[Claude Mythos 5](url)"), so dropping the link deletes the
 * name. Unwrapping handles both shapes, because a qualifier link is always inside parens —
 * "([retired, except on Google Cloud](url))" unwraps to "(retired, except on Google Cloud)"
 * and is then removed as a parenthetical.
 *
 * Doing this BEFORE splitting a name list matters: those qualifiers contain commas and the
 * word "and", which would otherwise shred one model name into unparseable fragments.
 */
export function stripDocMarkup(s: string): string {
  return stripFootnotes(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/\([^)]*\)/g, " ") // (deprecated), (retired, except on ...) -> drop
    .replace(/\*+/g, " "); // bold markers
}

export function displayNameToModelId(displayName: string): string | null {
  let s = stripDocMarkup(displayName.trim());
  // Qualifier tails that follow the name on dated / lifecycle rows.
  s = s.replace(/\b(through|starting|except|retired|deprecated|limited)\b.*$/i, " ");
  s = s.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s.startsWith("claude ")) return null;
  const id = s.replace(/\./g, "-").replace(/\s/g, "-");
  // Shape check rejects the fast-mode row's combined cell ("claude-opus-5 / claude-opus-4-8"
  // keeps its slash) and any prose that isn't id-shaped.
  if (!/^claude-[a-z]+(?:-[a-z0-9]+)*$/.test(id)) return null;
  // At least family + version, so "claude-models" is out. Deliberately NOT "must contain a
  // digit": that excluded claude-mythos-preview, a real model. A false positive here is
  // harmless (an overlay entry no transcript ever asks for); a false negative loses real data.
  if (id.split("-").length < 3) return null;
  return id;
}

/** Split a markdown table row into trimmed cells, dropping the leading/trailing empties. */
function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells = t.split("|").map((c) => c.trim());
  while (cells.length && cells[0] === "") cells.shift();
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * Fast-mode rates, from the "Fast mode pricing" section of the same page.
 *
 * Hazard 1 above cuts both ways: the fast table is three columns, exactly like the batch
 * table, and batch is a 50% DISCOUNT where fast is a 2x premium — reading one as the other
 * inverts the error. So this is anchored on the heading and stops at the next one, rather
 * than matching three-column rows anywhere on the page.
 *
 * The model cell lists several models at once ("Claude Opus 5 / Claude Opus 4.8"), which is
 * why the base-table parser rejects it: the slash survives id normalization. Here the slash
 * is the delimiter.
 */
const FAST_ANCHOR = /^#+\s.*fast mode pricing/i;
const HEADING = /^#+\s/;

export function parseFastPricing(markdown: string): { fast: Record<string, FastRates>; rejected: number } {
  const lines = markdown.split("\n");
  const fast: Record<string, FastRates> = {};
  let rejected = 0;

  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FAST_ANCHOR.test(lines[i]!)) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) return { fast, rejected };

  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (HEADING.test(line)) break; // next section — the table is behind us
    const cells = splitRow(line);
    if (!cells || cells.length !== 3) continue;
    const input = parsePriceCell(cells[1]!);
    const output = parsePriceCell(cells[2]!);
    if (input == null || output == null) continue; // header and separator rows
    // Same bounds as the base table. Output above input holds on every published row.
    if (input <= 0 || input > 1000 || output < input || output > 5000) {
      rejected++;
      continue;
    }
    for (const raw of stripDocMarkup(cells[0]!).split("/")) {
      const name = raw.trim();
      if (!name) continue;
      const id = displayNameToModelId(name);
      if (!id) {
        rejected++;
        continue;
      }
      if (!(id in fast)) fast[id] = { inputPerM: input, outputPerM: output };
    }
  }

  return { fast, rejected };
}

export function parsePricingDoc(markdown: string): PriceDocParse {
  const rows: ParsedPriceRow[] = [];
  const multiplierMismatch: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const line of markdown.split("\n")) {
    const cells = splitRow(line);
    // Exactly six columns is what separates the base-rate table from the 3-column
    // fast-mode and batch tables on the same page.
    if (!cells || cells.length !== 6) continue;

    const base = parsePriceCell(cells[1]!);
    const write5m = parsePriceCell(cells[2]!);
    const write1h = parsePriceCell(cells[3]!);
    const read = parsePriceCell(cells[4]!);
    const output = parsePriceCell(cells[5]!);
    // Every one of the five must be a price, or this is some other six-column table.
    if (base == null || write5m == null || write1h == null || read == null || output == null) continue;

    const modelId = displayNameToModelId(cells[0]!);
    if (!modelId) {
      rejected++;
      continue;
    }

    // Bounds: catches a decimal-point misread far more cheaply than any schema would.
    // Output exceeds input on every model Anthropic has published.
    if (base <= 0 || base > 1000 || output < base || output > 5000) {
      rejected++;
      continue;
    }

    if (
      !approxEqual(write5m, base * CACHE_WRITE_5M_MULT) ||
      !approxEqual(write1h, base * CACHE_WRITE_1H_MULT) ||
      !approxEqual(read, base * builtInCacheReadMult(modelId))
    ) {
      // Either a misparse or the multipliers moved. Refuse the row either way.
      if (!multiplierMismatch.includes(modelId)) multiplierMismatch.push(modelId);
      continue;
    }

    if (seen.has(modelId)) {
      if (!duplicates.includes(modelId)) duplicates.push(modelId);
      continue; // first row wins — see PriceDocParse.duplicates
    }
    seen.add(modelId);
    rows.push({ modelId, displayName: cells[0]!.trim(), inputPerM: base, outputPerM: output });
  }

  // Attach fast-mode rates to the rows they belong to. A "fast" rate at or below the base
  // rate is not a premium and means we read the wrong table, so it is dropped rather than
  // applied — that mistake would under-bill every fast turn instead of over-billing it,
  // which is the harder error to notice.
  const fastParse = parseFastPricing(markdown);
  rejected += fastParse.rejected;
  for (const row of rows) {
    const f = fastParse.fast[row.modelId];
    if (!f) continue;
    if (f.inputPerM <= row.inputPerM || f.outputPerM <= row.outputPerM) {
      rejected++;
      continue;
    }
    row.fast = f;
  }

  return { rows, multiplierMismatch, duplicates, rejected };
}

/**
 * Minimum cacheable prefix per model, from the prompt-caching page.
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
 *
 * Published as a bullet list, not a table:
 *   * 512 tokens for Claude Opus 5, Claude Fable 5, and [Claude Mythos 5](...)
 *   * 1,024 tokens for Claude Opus 4.8, ..., Claude Opus 4.1 ([deprecated](...)), and ...
 *
 * So: thousands separators, markdown links, per-name parentheticals, Oxford-comma lists,
 * and the same token count repeated across several bullets. Getting this wrong is quiet —
 * a too-low minimum makes ccc claim a prefix is cacheable when the API won't cache it,
 * and no error is ever returned for that.
 */
export interface CacheMinParse {
  /** modelId -> minimum tokens. */
  minimums: Record<string, number>;
  /** Bullets or names that looked like candidates but failed validation. */
  rejected: number;
}

/** Anchors the search; the bullets immediately follow this sentence. */
const MIN_ANCHOR = /minimum cacheable prompt length/i;
const MIN_BULLET = /^\s*[*-]\s*([\d,]+)\s*tokens?\s+for\s+(.+)$/i;

/** Every published minimum is a power of two — a cheap, strong misparse guard. */
function plausibleMinimum(n: number): boolean {
  return Number.isInteger(n) && n >= 256 && n <= 65536 && (n & (n - 1)) === 0;
}

export function parseCacheMinimums(markdown: string): CacheMinParse {
  const lines = markdown.split("\n");
  const minimums: Record<string, number> = {};
  let rejected = 0;

  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (MIN_ANCHOR.test(lines[i]!)) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) return { minimums, rejected };

  // Walk forward over the bullet block, tolerating blank lines between bullets but
  // stopping at the first prose paragraph so we don't wander into unrelated lists.
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const m = line.match(MIN_BULLET);
    if (!m) {
      if (/^\s*[*-]\s/.test(line)) {
        rejected++; // a bullet in this block we couldn't read
        continue;
      }
      break; // prose — end of the block
    }
    const tokens = Number(m[1]!.replace(/,/g, ""));
    if (!plausibleMinimum(tokens)) {
      rejected++;
      continue;
    }
    // "A, B ([retired, except on X](...)), and C" -> per-name ids. Strip markup FIRST: those
    // qualifiers carry their own commas and "and"s, which would otherwise split one name
    // into fragments that parse as nothing.
    for (const raw of stripDocMarkup(m[2]!).split(/,|\band\b/i)) {
      const name = raw.trim();
      if (!name) continue;
      const id = displayNameToModelId(name);
      if (!id) {
        rejected++;
        continue;
      }
      // First bullet wins if a model were ever listed twice.
      if (!(id in minimums)) minimums[id] = tokens;
    }
  }

  return { minimums, rejected };
}

/** Narrow a parse to the ids actually asked about, as PriceSpecs. */
export function specsFor(parse: PriceDocParse, wanted: Iterable<string>): Record<string, PriceSpec> {
  const want = new Set(wanted);
  const out: Record<string, PriceSpec> = {};
  for (const r of parse.rows) {
    if (want.has(r.modelId)) {
      out[r.modelId] = { inputPerM: r.inputPerM, outputPerM: r.outputPerM, ...(r.fast ? { fast: r.fast } : {}) };
    }
  }
  return out;
}
