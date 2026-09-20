import { saveFile } from "./download";

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
  // DELIVERY goes through the one helper (utils/download.js). `<a download>`
  // is ignored inside a Capacitor WKWebView, so on iOS the tap did nothing at
  // all — no file, no error, no clue; and the anchor fallback here revoked the
  // blob URL in the same tick as the click, which Safari treats as a cancel.
  // preferShare keeps this export's existing mobile-web behaviour (share sheet
  // wherever the browser offers file sharing, not only in the native shell).
  //
  // Returns true when the file actually left the app, so a caller can tell the
  // staffer instead of leaving them staring at a button that looked dead.
  const out = await saveFile(blob, filename, { preferShare: true, title: filename });
  return out.ok;
}
