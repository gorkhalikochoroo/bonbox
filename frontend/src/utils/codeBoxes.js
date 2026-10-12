/**
 * The six code boxes on /verify-email (mobile walk, 12 Oct 2026).
 *
 * Each box used to be maxLength=1 and kept only the LAST character of what
 * reached it. A whole code arriving as one input — iOS's code AutoFill from
 * Mail or Messages, a keyboard's clipboard chip on Android, a password
 * manager — therefore left a single digit in the first box and nothing else
 * (measured: "0" of "000000", no submit). Now a run of digits fills the row.
 *
 *   codeDigits(text)              the code in pasted text: the first run of
 *                                 exactly six digits ("Din kode: 482913"),
 *                                 else every digit, up to six ("482 913")
 *   applyBoxInput(code, i, raw)   box i now holds `raw` → { code, focus }
 */
export const CODE_LENGTH = 6;

const RUN = new RegExp(`(?:^|\\D)(\\d{${CODE_LENGTH}})(?!\\d)`);

export function codeDigits(text) {
  const s = String(text ?? "");
  const run = s.match(RUN);
  if (run) return run[1];
  return s.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function emptyCode() {
  return Array(CODE_LENGTH).fill("");
}

/** The first empty box at or after `from`, else the first empty one before
 *  it, else the last box. */
function nextEmpty(code, from) {
  for (let i = from; i < CODE_LENGTH; i++) if (!code[i]) return i;
  for (let i = 0; i < from; i++) if (!code[i]) return i;
  return CODE_LENGTH - 1;
}

export function applyBoxInput(code, index, raw) {
  const prev = code[index] || "";
  const text = String(raw ?? "");
  let digits = text.replace(/\D/g, "");
  // Text with other numbers around the code ("Kode 2: 482913" from a
  // clipboard chip or a password manager) arriving as one input: take the
  // six-digit run, as a paste does — not every digit in the text.
  if (/\D/.test(text) && digits.length > CODE_LENGTH) digits = codeDigits(text);
  const next = [...code];

  // Nothing, or one digit: the box holds it (a deletion leaves the focus here).
  if (digits.length <= 1) {
    next[index] = digits;
    return { code: next, focus: digits ? Math.min(index + 1, CODE_LENGTH - 1) : index };
  }

  // Two digits where one was: typed beside the old digit — the new one wins.
  if (digits.length === 2 && prev && (digits[0] === prev || digits[1] === prev)) {
    next[index] = digits[0] === prev ? digits[1] : digits[0];
    return { code: next, focus: Math.min(index + 1, CODE_LENGTH - 1) };
  }

  // A run beside the old digit (the caret was not over it): drop the old one.
  if (prev && digits.length === CODE_LENGTH + 1) {
    if (digits.startsWith(prev)) digits = digits.slice(1);
    else if (digits.endsWith(prev)) digits = digits.slice(0, -1);
  }

  // A whole code fills the row from the first box; a part fills from here on.
  const start = digits.length >= CODE_LENGTH ? 0 : index;
  const run = digits.slice(0, CODE_LENGTH - start);
  for (let k = 0; k < run.length; k++) next[start + k] = run[k];
  return { code: next, focus: nextEmpty(next, Math.min(start + run.length, CODE_LENGTH - 1)) };
}

export function isComplete(code) {
  return code.length === CODE_LENGTH && code.every((d) => /^\d$/.test(d));
}
