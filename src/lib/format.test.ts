import {
  centsToEditableString,
  formatCents,
  formatGameDate,
  formatGameTime,
  formatSignedCents,
  parseDollarsToCents,
  parseSignedDollarsToCents,
} from './format';

describe('parseDollarsToCents', () => {
  it('parses a whole dollar amount', () => {
    expect(parseDollarsToCents('25')).toBe(2500);
  });

  it('parses one decimal place as a dime, not a cent', () => {
    expect(parseDollarsToCents('25.5')).toBe(2550);
  });

  it('parses two decimal places', () => {
    expect(parseDollarsToCents('25.50')).toBe(2550);
  });

  it('parses zero', () => {
    expect(parseDollarsToCents('0')).toBe(0);
    expect(parseDollarsToCents('0.00')).toBe(0);
  });

  it('parses a single cent without float rounding error', () => {
    // Number("19.99") * 100 is 1998.9999999999998 in JS - this must not be that.
    expect(parseDollarsToCents('19.99')).toBe(1999);
    expect(parseDollarsToCents('0.01')).toBe(1);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDollarsToCents('  25.50  ')).toBe(2550);
  });

  it('rejects an empty or blank string', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('   ')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('$25')).toBeNull();
    expect(parseDollarsToCents('25,50')).toBeNull();
  });

  it('rejects a negative amount', () => {
    // Every money input in this app (buy-ins, cash-outs) is non-negative.
    expect(parseDollarsToCents('-5')).toBeNull();
  });

  it('rejects more than two decimal places', () => {
    expect(parseDollarsToCents('25.500')).toBeNull();
  });

  it('rejects a bare trailing decimal point', () => {
    expect(parseDollarsToCents('25.')).toBeNull();
  });
});

describe('formatCents', () => {
  it('formats zero', () => {
    expect(formatCents(0)).toBe('$0.00');
  });

  it('formats a whole dollar amount', () => {
    expect(formatCents(2500)).toBe('$25.00');
  });

  it('pads a single cent', () => {
    expect(formatCents(5)).toBe('$0.05');
  });

  it('inserts thousands separators', () => {
    expect(formatCents(123_456_789)).toBe('$1,234,567.89');
  });

  it('is never signed, even given a negative input', () => {
    // formatCents is for amounts (buy-ins, cash-outs), which are never negative in
    // this app, but must still render sensibly if ever called with one.
    expect(formatCents(-2500)).toBe('$25.00');
  });
});

describe('formatSignedCents', () => {
  it('shows no sign for exactly zero', () => {
    expect(formatSignedCents(0)).toBe('$0.00');
  });

  it('prefixes a gain with +', () => {
    expect(formatSignedCents(5000)).toBe('+$50.00');
  });

  it('prefixes a loss with -', () => {
    expect(formatSignedCents(-2000)).toBe('-$20.00');
  });

  it('signs a single cent correctly in both directions', () => {
    expect(formatSignedCents(1)).toBe('+$0.01');
    expect(formatSignedCents(-1)).toBe('-$0.01');
  });
});

describe('formatGameDate', () => {
  it('formats a timestamp as a short US date', () => {
    // Full "Month D, YYYY" shape, timezone-independent - a fixed literal string
    // would be one UTC offset away from flaking in CI.
    expect(formatGameDate('2026-09-19T12:00:00Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });
});

describe('formatGameTime', () => {
  it('formats a timestamp as a 12-hour clock time', () => {
    // Shape only ("H:MM AM/PM", no leading zero on the hour) - the exact hour
    // depends on the machine's local timezone, same reasoning as formatGameDate.
    expect(formatGameTime('2026-09-19T12:00:00Z')).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('parseSignedDollarsToCents', () => {
  it('parses a positive amount exactly like parseDollarsToCents', () => {
    expect(parseSignedDollarsToCents('25.50')).toBe(2550);
  });

  it('parses a negative amount', () => {
    expect(parseSignedDollarsToCents('-25.50')).toBe(-2550);
  });

  it('parses a negative single cent without float rounding error', () => {
    expect(parseSignedDollarsToCents('-19.99')).toBe(-1999);
  });

  it('parses zero regardless of a leading sign', () => {
    expect(parseSignedDollarsToCents('0')).toBe(0);
    expect(parseSignedDollarsToCents('-0')).toBe(0);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSignedDollarsToCents('  -25.50  ')).toBe(-2550);
  });

  it('rejects a bare minus sign', () => {
    expect(parseSignedDollarsToCents('-')).toBeNull();
  });

  it('rejects a double sign', () => {
    expect(parseSignedDollarsToCents('--5')).toBeNull();
  });

  it('rejects the same malformed input parseDollarsToCents rejects', () => {
    expect(parseSignedDollarsToCents('')).toBeNull();
    expect(parseSignedDollarsToCents('abc')).toBeNull();
    expect(parseSignedDollarsToCents('25.500')).toBeNull();
  });
});

describe('centsToEditableString', () => {
  it('formats a whole dollar amount', () => {
    expect(centsToEditableString(8000)).toBe('80.00');
  });

  it('pads a single cent', () => {
    expect(centsToEditableString(5)).toBe('0.05');
  });

  it('formats zero', () => {
    expect(centsToEditableString(0)).toBe('0.00');
  });

  it('signs a negative amount', () => {
    expect(centsToEditableString(-2000)).toBe('-20.00');
  });

  it('never inserts thousands separators, unlike formatCents', () => {
    // This string is meant to be re-parsed by parseDollarsToCents, which does
    // not understand commas.
    expect(centsToEditableString(123_456_789)).toBe('1234567.89');
  });

  it('round-trips through parseDollarsToCents', () => {
    expect(parseDollarsToCents(centsToEditableString(8050))).toBe(8050);
  });
});
