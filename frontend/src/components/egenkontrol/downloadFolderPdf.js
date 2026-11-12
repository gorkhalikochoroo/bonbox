/**
 * Hent Kontrolmappen som PDF — the owner's and the manager's download.
 *
 * api blob GET → utils/download.saveFile, which hands the file to the native
 * share sheet inside the iOS / Android shell (no download manager there) and
 * downloads it on the web. Returns saveFile's REAL outcome, so the caller
 * shows "PDF klar" only on { ok: true } — never a "hentet ✓" for a file that
 * went nowhere. No @capacitor/filesystem or share plugins.
 *
 * The venue name, address and CVR on the PDF come from the account on the
 * server; nothing here sends them.
 */
import api from "../../services/api";
import { saveFile } from "../../utils/download";
import { last30 } from "./ekLogic";

export default async function downloadFolderPdf({ from = null, to = null, businessDate = null, branchId = null } = {}) {
  let range = { from, to };
  if (!range.from || !range.to) range = last30(businessDate);
  const params = {};
  if (range.from && range.to) {
    params.from = range.from;
    params.to = range.to;
  }
  if (branchId) params.branch_id = branchId;
  let res;
  try {
    res = await api.get("/egenkontrol/folder.pdf", { params, responseType: "blob" });
  } catch (err) {
    return { ok: false, reason: err?.response?.status ? `http_${err.response.status}` : "network" };
  }
  const name = range.from && range.to ? `Kontrolmappe_${range.from}_${range.to}.pdf` : "Kontrolmappe.pdf";
  try {
    return await saveFile(res?.data, name, { type: "application/pdf", title: "Kontrolmappe" });
  } catch (e) {
    return { ok: false, reason: e?.message || "save_failed" };
  }
}
