import { fatal, invariant, type EscapementError } from "../core/errors.ts";
import { ok, err, type Result } from "../core/result.ts";
import type { JsonObject } from "../core/json.ts";
import type { Message } from "../core/messages.ts";
import type { Tokenizer } from "./tokenizer.ts";
import { Overflow, itemText, type Section } from "./sections.ts";

export type PackBudget = {
  /** Total context window, in tokens. */
  readonly total: number;
  /** Held back for the model's reply. Never packed into. */
  readonly reserveForOutput: number;
  /** Extra fraction held back when the tokenizer is inexact. Default 0.08.
   *  Ignored entirely when `tokenizer.exact` is true. */
  readonly safetyMargin?: number;
};

export type SectionReport = {
  readonly id: string;
  readonly priority: number;
  readonly pinned: boolean;
  readonly requested: number;
  readonly allocated: number;
  readonly used: number;
  readonly itemsTotal: number;
  readonly itemsIncluded: number;
  readonly itemsDropped: number;
  readonly itemsTruncated: number;
  readonly starved: boolean;
};

/**
 * The audit trail for one assembly.
 *
 * It goes into the ledger, which means graders can assert on what the model was
 * given rather than only on what it produced — "retrieval was never starved",
 * "the window never exceeded budget", "memory got at least its floor". Without
 * this, context bugs are invisible until they show up as bad answers.
 */
export type PackReport = {
  readonly tokenizer: string;
  readonly exact: boolean;
  readonly total: number;
  readonly reserveForOutput: number;
  readonly safetyMargin: number;
  readonly usable: number;
  readonly pinnedUsed: number;
  readonly used: number;
  readonly remaining: number;
  readonly sections: readonly SectionReport[];
  readonly droppedItems: number;
};

export type PackedContext = {
  readonly messages: readonly Message[];
  readonly tokens: number;
  readonly report: PackReport;
};

const DEFAULT_SAFETY_MARGIN = 0.08;

/**
 * Deterministic budgeted packing (ADR-0011).
 *
 * Four passes, in this order:
 *
 *   1. Reserve — subtract the output reservation and, for an inexact
 *      tokenizer, a safety margin.
 *   2. Pinned — allocate required sections in full, in priority order. If they
 *      do not fit, fail. We will not silently shorten something declared
 *      essential.
 *   3. Fair share — give each discretionary section `min(want, maxShare * pool)`
 *      in priority order, then hand leftover space back out ignoring the caps.
 *   4. Fill — walk each section's items in order, applying its overflow policy.
 *
 * Every step is a pure function of its inputs, ties break on section id, and
 * nothing consults a clock or an RNG. The same sections and the same budget
 * always produce the same window.
 */
export function pack(
  sections: readonly Section[],
  budget: PackBudget,
  tokenizer: Tokenizer,
): Result<PackedContext, EscapementError> {
  invariant(budget.total > 0, "context budget must be positive", budget.total);
  invariant(budget.reserveForOutput >= 0, "output reservation cannot be negative", budget.reserveForOutput);

  const margin = tokenizer.exact ? 0 : (budget.safetyMargin ?? DEFAULT_SAFETY_MARGIN);
  const usable = Math.floor((budget.total - budget.reserveForOutput) * (1 - margin));

  if (usable <= 0) {
    return err(
      fatal(
        "context.no_space",
        `Output reservation of ${budget.reserveForOutput} leaves no room in a ${budget.total} token window.`,
        { total: budget.total, reserveForOutput: budget.reserveForOutput, margin },
      ),
    );
  }

  const ordered = [...sections].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  const cost = costFn(tokenizer);

  // --- Pass 2: pinned ------------------------------------------------------
  const pinned = ordered.filter((s) => s.pinned === true);
  const pinnedCost = pinned.reduce((sum, s) => sum + sectionCost(s, cost), 0);

  if (pinnedCost > usable) {
    return err(
      fatal(
        "context.pinned_overflow",
        `Pinned sections need ${pinnedCost} tokens but only ${usable} are usable. Unpin a section or raise the budget.`,
        {
          required: pinnedCost,
          usable,
          sections: pinned.map((s) => ({ id: s.id, tokens: sectionCost(s, cost) })),
        },
      ),
    );
  }

  // --- Pass 3: fair share --------------------------------------------------
  const discretionary = ordered.filter((s) => s.pinned !== true);
  let pool = usable - pinnedCost;
  const allocation = new Map<string, number>();

  for (const section of discretionary) {
    const want = sectionCost(section, cost);
    const cap = section.maxShare === undefined ? pool : Math.floor(section.maxShare * pool);
    const give = Math.min(want, cap, pool);
    allocation.set(section.id, give);
    pool -= give;
  }

  // Leftover ignores maxShare: the cap exists to stop one section starving
  // another while they compete, not to waste space nobody else wants.
  for (const section of discretionary) {
    if (pool <= 0) break;
    const want = sectionCost(section, cost);
    const current = allocation.get(section.id) ?? 0;
    if (current >= want) continue;
    const extra = Math.min(want - current, pool);
    allocation.set(section.id, current + extra);
    pool -= extra;
  }

  // A section that cannot clear its floor gets nothing at all.
  for (const section of discretionary) {
    const given = allocation.get(section.id) ?? 0;
    if (section.minTokens !== undefined && given < section.minTokens) allocation.set(section.id, 0);
  }

  // --- Pass 4: fill --------------------------------------------------------
  const reports: SectionReport[] = [];
  const rendered = new Map<string, readonly Message[]>();

  for (const section of ordered) {
    const isPinned = section.pinned === true;
    const allocated = isPinned ? sectionCost(section, cost) : (allocation.get(section.id) ?? 0);
    const filled = fill(section, allocated, cost, tokenizer);
    rendered.set(section.id, filled.messages);
    reports.push({
      id: section.id,
      priority: section.priority,
      pinned: isPinned,
      requested: sectionCost(section, cost),
      allocated,
      used: filled.used,
      itemsTotal: section.items.length,
      itemsIncluded: filled.included,
      itemsDropped: section.items.length - filled.included,
      itemsTruncated: filled.truncated,
      starved: section.items.length > 0 && filled.included === 0,
    });
  }

  const messages = [...ordered]
    .sort((a, b) => (a.order ?? a.priority) - (b.order ?? b.priority) || (a.id < b.id ? -1 : 1))
    .flatMap((s) => rendered.get(s.id) ?? []);

  const used = reports.reduce((sum, r) => sum + r.used, 0);
  const report: PackReport = {
    tokenizer: tokenizer.name,
    exact: tokenizer.exact,
    total: budget.total,
    reserveForOutput: budget.reserveForOutput,
    safetyMargin: margin,
    usable,
    pinnedUsed: reports.filter((r) => r.pinned).reduce((sum, r) => sum + r.used, 0),
    used,
    remaining: usable - used,
    sections: reports,
    droppedItems: reports.reduce((sum, r) => sum + r.itemsDropped, 0),
  };

  invariant(used <= usable, "packer produced a window larger than the usable budget", { used, usable });

  return ok({ messages, tokens: used, report });
}

/** The report, as JSON for the ledger. */
export const reportToJson = (report: PackReport): JsonObject => JSON.parse(JSON.stringify(report)) as JsonObject;

// ---------------------------------------------------------------------------

function costFn(tokenizer: Tokenizer): (text: string) => number {
  const cache = new Map<string, number>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const value = tokenizer.count(text);
    cache.set(text, value);
    return value;
  };
}

function blockOverhead(section: Section, cost: (text: string) => number): number {
  if (section.render?.mode !== "block") return 0;
  const header = section.render.header;
  return header === undefined ? 0 : cost(`${header}\n\n`);
}

function sectionCost(section: Section, cost: (text: string) => number): number {
  const items = section.items.reduce((sum, item) => sum + cost(itemText(item)), 0);
  return items === 0 ? 0 : items + blockOverhead(section, cost);
}

type Filled = { messages: readonly Message[]; used: number; included: number; truncated: number };

function fill(
  section: Section,
  allocated: number,
  cost: (text: string) => number,
  tokenizer: Tokenizer,
): Filled {
  if (section.items.length === 0 || allocated <= 0) {
    return { messages: [], used: 0, included: 0, truncated: 0 };
  }

  const policy = section.overflow ?? Overflow.Drop;
  const overhead = blockOverhead(section, cost);

  // If the section cannot fit whole, the elision note is going to be needed, and
  // it is worth more than the last item it would displace — a reader who cannot
  // see that something was cut will assume nothing was. So reserve room for it
  // up front, using the worst-case count as the bound.
  const willElide = section.elisionNote !== undefined && sectionCost(section, cost) > allocated;
  const noteReserve = willElide && section.elisionNote ? cost(section.elisionNote(section.items.length)) : 0;

  let budget = allocated - overhead - noteReserve;
  if (budget <= 0) return { messages: [], used: 0, included: 0, truncated: 0 };

  const kept: { text: string; item: (typeof section.items)[number] }[] = [];
  let truncated = 0;

  for (const item of section.items) {
    const text = itemText(item);
    const size = cost(text);
    if (size <= budget) {
      kept.push({ text, item });
      budget -= size;
      continue;
    }
    if (policy === Overflow.Truncate) {
      const shortened = tokenizer.truncate(text, budget);
      if (shortened.length > 0) {
        kept.push({ text: shortened, item });
        budget -= cost(shortened);
        truncated += 1;
      }
      break;
    }
    // Drop: skip it, but keep going — a later, smaller item may still fit.
  }

  if (kept.length === 0) return { messages: [], used: 0, included: 0, truncated: 0 };

  // The elision note is content too, and it has to come out of the section's own
  // allocation. If it does not fit we drop it rather than quietly overrunning.
  const droppedCount = section.items.length - kept.length;
  const candidateNote = droppedCount > 0 && section.elisionNote ? section.elisionNote(droppedCount) : null;
  const note = candidateNote !== null && cost(candidateNote) <= budget + noteReserve ? candidateNote : null;

  if (section.render?.mode === "block") {
    const separator = section.render.separator ?? "\n\n";
    const body = kept.map((k) => k.text).join(separator);
    const parts = [section.render.header, body, note].filter((p): p is string => Boolean(p));
    const content = parts.join("\n\n");
    const message = { role: section.render.role, content } as Message;
    return { messages: [message], used: cost(content), included: kept.length, truncated };
  }

  const messages: Message[] = kept.map((k) =>
    k.text === itemText(k.item) ? k.item.message : ({ ...k.item.message, content: k.text } as Message),
  );
  if (note !== null) messages.unshift({ role: "system", content: note });

  const used = messages.reduce((sum, m) => sum + cost(m.content), 0);
  return { messages, used, included: kept.length, truncated };
}
