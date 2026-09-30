/**
 * Money and date formatting shared by every screen that shows or collects a
 * dollar amount. Pure functions, no UI, no DB - parallels `settlement.ts`.
 *
 * All money in the database is integer cents (CLAUDE.md). These are the only two
 * places a dollar string and a cents integer are allowed to meet.
 */

/**
 * Parse a dollars-and-cents string ("25", "25.5", "25.50") into integer cents.
 * Returns null for anything that is not a plain non-negative amount - a stray
 * letter, more than two decimal places, a sign, or an empty field. Almost every
 * money input in this app is an amount rather than a delta (a buy-in, a
 * cashed-out stack, a total to set) and can't be negative, so a leading "-" is
 * rejected rather than silently accepted. The one exception - a buy-in
 * correction, which is a signed adjustment - uses parseSignedDollarsToCents
 * instead of loosening this one.
 *
 * Deliberately not `Number(input) * 100`: floating point cannot represent every
 * cents amount exactly ("19.99" * 100 is 1998.9999999999998 in JS), which would
 * round a real buy-in to the wrong cent. Splitting on the decimal point and
 * working in integers avoids that entirely.
 */
export function parseDollarsToCents(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;

  const [, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Like parseDollarsToCents, but also accepts one optional leading "-".
 *
 * The single money input in this app that is a signed delta rather than an
 * amount: a buy-in correction, entered to net out a mis-click (see
 * `buy_ins_amount_nonzero` - the database accepts a negative buy_ins row for
 * exactly this). Everywhere else - a buy-in, a cash-out, a total to set -
 * parseDollarsToCents's non-negative rule is the correct one; this exists
 * alongside it rather than replacing it.
 */
export function parseSignedDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  const isNegative = trimmed.startsWith('-');
  const magnitude = parseDollarsToCents(isNegative ? trimmed.slice(1) : trimmed);
  if (magnitude === null) return null;
  // "-0" -> 0, not -0: a negative zero is not a real value anywhere else in this
  // app and would only invite a confusing edge case in a future caller.
  return isNegative && magnitude !== 0 ? -magnitude : magnitude;
}

/**
 * 2550 (cents) -> "$25.50". Never signed - for buy-ins and cash-outs, which are
 * always non-negative amounts, not gains or losses.
 */
export function formatCents(cents: number): string {
  const wholePart = Math.floor(Math.abs(cents) / 100);
  const centsPart = Math.abs(cents) % 100;
  return `$${withThousandsSeparators(wholePart)}.${String(centsPart).padStart(2, '0')}`;
}

/**
 * 5000 -> "+$50.00", -2000 -> "-$20.00", 0 -> "$0.00". For a player's net - a gain
 * or a loss, so the sign carries real meaning.
 */
export function formatSignedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  return (cents > 0 ? '+' : '-') + formatCents(cents);
}

function withThousandsSeparators(wholeDollars: number): string {
  return wholeDollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 8000 (cents) -> "80.00". Unlike formatCents, no "$" and no thousands
 * separators - this is for pre-filling a TextInput the player is about to edit
 * and parseDollarsToCents will re-parse, not for read-only display.
 */
export function centsToEditableString(cents: number): string {
  const wholePart = Math.floor(Math.abs(cents) / 100);
  const centsPart = Math.abs(cents) % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}${wholePart}.${String(centsPart).padStart(2, '0')}`;
}

/**
 * A timestamptz string -> "Sep 19, 2026", for the past-games list, which only
 * needs the day a game was played.
 */
export function formatGameDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * A timestamptz string -> "8:42 PM" (12-hour clock, no leading zero on the hour).
 * Pairs with formatGameDate on the past-games list.
 */
export function formatGameTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
