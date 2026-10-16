/**
 * Minimal RFC 4180 CSV reader: comma-separated, `"`-quoted fields with `""`
 * escapes, quoted fields may contain commas and newlines (spell descriptions
 * do). Yields one record at a time so large tables never materialize as one
 * big array of rows.
 */
export function* parseCsv(text: string): Generator<string[]> {
  const len = text.length;
  let i = 0;
  while (i < len) {
    const record: string[] = [];
    for (;;) {
      let field: string;
      if (text.charCodeAt(i) === 34 /* " */) {
        // Quoted field: scan to the closing quote, unescaping "".
        let out = "";
        let start = ++i;
        for (;;) {
          const close = text.indexOf('"', i);
          if (close === -1) throw new Error("CSV: unterminated quoted field");
          if (text.charCodeAt(close + 1) === 34) {
            out += text.slice(start, close + 1);
            i = start = close + 2;
            continue;
          }
          out += text.slice(start, close);
          i = close + 1;
          break;
        }
        field = out;
      } else {
        let end = i;
        while (end < len) {
          const c = text.charCodeAt(end);
          if (c === 44 /* , */ || c === 10 /* \n */ || c === 13 /* \r */) break;
          end++;
        }
        field = text.slice(i, end);
        i = end;
      }
      record.push(field);

      const c = text.charCodeAt(i);
      if (c === 44) {
        i++;
        continue;
      }
      // End of record: \n, \r\n, or end of input.
      if (c === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    yield record;
  }
}
