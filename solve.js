// A fast drop-in replacement for csv-reader 1.0.0, written for make.fun's
// csv-reader-speed-01. run(input) returns exactly the answer csv-reader 1.0.0
// returns for {text, header}: {columns, rows, errors}, under csv-reader's own
// broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF); what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row) or cut (long_row) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside quotes counted), row its
//     record's index in rows (null for the header), in the order met.
//
// Where the reference walks one character at a time and builds each field by
// concatenation, this reader scans with charCodeAt and cuts each field (or
// each unbroken run of one) out of the text with a single slice, so the hot
// loop does no per-character string building. Fields that meet a dropped
// stray CR, a doubled quote or a CR inside quotes are joined from their runs
// instead; those are the rare paths.
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

// How a field ended: 0 at a comma (the record goes on), 1 at a line break,
// 2 at the end of the text (the record ends either way).

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null while it is the header). The field readers report their
  // errors against these.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma, line break
  // or the end of the text: a CR not followed by LF is dropped (stray_cr).
  // Returns [value, ended, added], added counting the characters kept.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    let parts = null; // [value, ...runs] once a stray CR splits the field
    for (;;) {
      if (pos >= n) {
        const tail = text.slice(start, n);
        added += tail.length;
        if (parts !== null) {
          parts.push(tail);
          return [parts.join(''), 2, added];
        }
        return [value + tail, 2, added];
      }
      const c = text.charCodeAt(pos);
      if (c === 44 || c === 10 || (c === 13 && text.charCodeAt(pos + 1) === 10)) {
        const tail = text.slice(start, pos);
        added += tail.length;
        let ended;
        if (c === 44) {
          pos += 1;
          ended = 0;
        } else if (c === 10) {
          pos += 1;
          line += 1;
          ended = 1;
        } else {
          pos += 2;
          line += 1;
          ended = 1;
        }
        if (parts !== null) {
          parts.push(tail);
          return [parts.join(''), ended, added];
        }
        return [value + tail, ended, added];
      }
      if (c === 13) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const run = text.slice(start, pos);
        added += run.length;
        if (parts === null) parts = [value, run];
        else parts.push(run);
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    let parts = null; // runs of the field, split at doubled quotes and CRs
    let value = '';
    let closed = false;
    for (;;) {
      if (pos >= n) break;
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          // A doubled quote is one quote in the field.
          const run = text.slice(start, pos);
          if (parts === null) parts = [run, '"'];
          else parts.push(run, '"');
          pos += 2;
          start = pos;
          continue;
        }
        const run = text.slice(start, pos);
        if (parts === null) value = run;
        else {
          parts.push(run);
          value = parts.join('');
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each read as one LF.
        const run = text.slice(start, pos);
        if (parts === null) parts = [run, '\n'];
        else parts.push(run, '\n');
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        start = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      const again = readUnquoted('"');
      return [again[0], again[1]];
    }
    if (pos >= n) return [value, 2];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, 1];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, 1];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break; that tail is quote junk when it kept a
    // character (its own stray CRs are reported first, as they are met).
    const junk = readUnquoted(value);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return [junk[0], junk[1]];
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
    const fields = [];
    let quoted = false;
    let ended = 0;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
      ended = field[1];
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
