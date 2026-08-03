export async function exportToCsv(filename, rows, columns) {
  // columns = [{key: "date", label: "Date"}, {key: "amount", label: "Amount"}]
  const header = columns.map(c => c.label).join(",");
  const csv = rows.map(row =>
    columns.map(c => {
      let val = row[c.key] ?? "";
      if (typeof val === "string" && (val.includes(",") || val.includes('"'))) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(",")
  );
  // UTF-8 BOM ("﻿") is critical for Danish accountants: Windows Excel
  // defaults to Windows-1252 when no BOM is present, mangling Æ Ø Å in
  // column headers + supplier names. Mac Numbers / LibreOffice autodetect
  // UTF-8 fine either way. Without this, every Dinero / e-conomic / Billy
  // import from BonBox shows garbled Danish characters.
  const blob = new Blob(
    ["﻿" + header + "\n" + csv.join("\n")],
    { type: "text/csv;charset=utf-8" },
  );
  // DELIVERY. `<a download>` is ignored inside a Capacitor WKWebView, so on
  // iOS the tap did nothing at all — no file, no error, no clue. Try the
  // native share sheet first when the platform offers file sharing, and fall
  // back to the anchor on desktop browsers where that is the right gesture.
  //
  // Returns true when the file actually left the app, so a caller can tell the
  // staffer instead of leaving them staring at a button that looked dead.
  if (canShareFiles()) {
    try {
      const file = new File([blob], filename, { type: "text/csv" });
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      // A user-cancelled share is not a failure — do not then dump a
      // download on them as if the cancel had not happened.
      if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) return false;
      // Anything else: fall through to the anchor.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Firefox needs the anchor in the DOM to honor .click(); Chrome/Safari
  // don't but it doesn't hurt them. Cleanup happens immediately.
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

/** Web Share Level 2 with files — the only path that works in a WKWebView. */
function canShareFiles() {
  try {
    if (typeof navigator === "undefined") return false;
    if (typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.csv", { type: "text/csv" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}
