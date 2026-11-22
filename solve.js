// solve.js — a fast, dependency-free reimplementation of csv-reader 1.0.0's readCsv.
//
// It returns exactly the same {columns, rows, errors} as the reference for every
// {text, header} input, but reads with jumps instead of one character at a time:
// a record with no quote at all is one line split on commas, an unquoted field is
// one regex step to the next comma, line break or CR, and a quoted field jumps from
// quote to quote. The policy is the reference's own:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended as
//     it stands (quote_junk, when the field ends); a quote that never closes is a
//     literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its field count) or cut (long_row, with extra: the
//     cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next comma, line break or CR at or after pos, one native step.
  const SEP = /[,\r\n]/g;
  // Whether a string holds a line break at all (the common quoted segment holds none).
  const HASBR = /[\r\n]/;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The field just read, and how it ended (COMMA, LINE_BREAK or END); fAdded counts
  // the characters scanUnquoted kept (for the quote_junk check).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Appends text[a..b) to value, counting each LF, CRLF and lone CR in it as one
  // line and reading each as one LF in the value. The common case (no line break
  // in the segment) is a plain slice.
  function appendSegment(value, a, b) {
    const s = text.slice(a, b);
    if (!HASBR.test(s)) return value + s;
    return value + s.replace(/\r\n?|\n/g, () => {
      line += 1;
      return '\n';
    });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr) and the field goes on. Sets fValue,
  // fEnded and fAdded.
  function scanUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        const s = text.slice(pos);
        value += s;
        added += s.length;
        pos = n;
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      const end = m.index;
      const ch = m[0];
      if (ch === ',') {
        const s = text.slice(pos, end);
        value += s;
        added += s.length;
        pos = end + 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (ch === '\n') {
        const s = text.slice(pos, end);
        value += s;
        added += s.length;
        pos = end + 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // A CR: CRLF ends the field at a line break, a lone CR is dropped.
      if (text.charCodeAt(end + 1) === 10) {
        const s = text.slice(pos, end);
        value += s;
        added += s.length;
        pos = end + 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      const s = text.slice(pos, end);
      value += s;
      added += s.length;
      pushError('stray_cr');
      pos = end + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    let seg = p;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        scanUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote in the value.
        value = appendSegment(value, seg, q);
        value += '"';
        p = q + 2;
        seg = p;
        continue;
      }
      // The closing quote.
      value = appendSegment(value, seg, q);
      pos = q + 1;
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      scanUnquoted(value);
      if (fAdded > 0) pushError('quote_junk');
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote at all is one line split on commas. A
    // trailing CR is the CRLF line break; any other CR falls through to the
    // field-by-field reader, which records it as stray_cr.
    let fields;
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= lineEnd) {
      const ri = text.indexOf('\r', pos);
      if (ri === -1 || ri >= lineEnd) {
        fields = text.slice(pos, lineEnd).split(',');
        pos = le === -1 ? n : le + 1;
        if (le !== -1) line += 1;
      } else if (le !== -1 && ri === lineEnd - 1) {
        fields = text.slice(pos, lineEnd - 1).split(',');
        pos = le + 1;
        line += 1;
      }
    }
    if (fields === undefined) {
      fields = [];
      let quoted;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) scanQuoted();
        else scanUnquoted('');
        fields.push(fValue);
      } while (fEnded === COMMA);

      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
