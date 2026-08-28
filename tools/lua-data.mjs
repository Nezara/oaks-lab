// A parser for the engine's generated data files
// (%APPDATA%/pokemon-love2d/<game>/data/generated/*.lua).
//
// Those files are written by the engine's own pretty-printer, so they use a
// tiny, predictable subset of Lua: `return` followed by one table of string
// keys, numbers, booleans and nested tables. That is small enough to parse
// exactly, which beats regex-scraping ids out of them.

export function parseLuaData(src) {
  let i = 0;

  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("--[[", i)) { const e = src.indexOf("]]", i); i = e < 0 ? src.length : e + 2; continue; }
      if (src.startsWith("--", i)) { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e + 1; continue; }
      return;
    }
  };

  const fail = (what) => {
    const line = src.slice(0, i).split("\n").length;
    throw new Error(`${what} at line ${line}: ${JSON.stringify(src.slice(i, i + 40))}`);
  };

  function readString() {
    const quote = src[i++];
    let out = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") {
        const c = src[++i];
        // Lua's decimal escape: \ddd, up to three digits. The engine's text
        // table is full of them -- \012 is the control code for "next text
        // box" -- so reading one a character at a time turns dialogue into
        // gibberish ("\012" became the literal "012").
        if (c >= "0" && c <= "9") {
          const digits = /^\d{1,3}/.exec(src.slice(i))[0];
          i += digits.length;
          out += String.fromCharCode(Number(digits));
          continue;
        }
        i++;
        out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
      } else out += src[i++];
    }
    i++;                       // closing quote
    return out;
  }

  function readValue() {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return readString();
    if (c === "{") return readTable();
    if (src.startsWith("true", i))  { i += 4; return true; }
    if (src.startsWith("false", i)) { i += 5; return false; }
    if (src.startsWith("nil", i))   { i += 3; return null; }
    const m = /^-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)/.exec(src.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    fail("unexpected value");
  }

  function readTable() {
    i++;                       // {
    // A Lua table is a hash and an array at once. Collect both, then decide:
    // positional-only tables become JS arrays, anything with keys an object.
    const hash = {}, arr = [];
    let hasKeys = false;
    for (;;) {
      ws();
      if (src[i] === "}") { i++; break; }
      if (src[i] === "," || src[i] === ";") { i++; continue; }

      let key = null;
      if (src[i] === "[") {                            // ["key"] = / [1] =
        i++;
        key = readValue();
        ws();
        if (src[i] !== "]") fail("expected ]");
        i++; ws();
        if (src[i] !== "=") fail("expected = after [key]");
        i++;
      } else {
        const m = /^[A-Za-z_]\w*/.exec(src.slice(i));
        if (m) {
          const after = /^\s*=(?!=)/.exec(src.slice(i + m[0].length));
          if (after) { key = m[0]; i += m[0].length + after[0].length; }
        }
      }

      const value = readValue();
      if (key === null) arr.push(value);
      else { hash[key] = value; hasKeys = true; }
    }
    if (!hasKeys) return arr;
    for (let n = 0; n < arr.length; n++) hash[n + 1] = arr[n];
    return hash;
  }

  ws();
  if (src.startsWith("return", i)) i += 6;
  return readValue();
}
