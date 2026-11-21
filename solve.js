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
