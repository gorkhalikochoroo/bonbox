/**
 * StaffBankRow — the owner's view of a staff member's bank account.
 *
 * The other half of the portal's BankSection: the staffer enters their account,
 * the owner reads it here to pay them. Four deliberate choices:
 *
 *  1. NOT FETCHED ON RENDER. The account is only requested when the owner taps
 *     "Show" — which is what makes the audit trail mean something. If it loaded
 *     with the drawer, `staff.bank_viewed` would fire every time anyone opened
 *     a staff member and the log would answer nothing.
 *  2. THE OWNER CANNOT EDIT IT. There is no owner write endpoint, by design: an
 *     account typed by the person being paid is the one worth trusting. The
 *     owner can view it and remove it, nothing else. A "wrong number" is fixed
 *     by the staffer in their portal.
 *  3. REMOVAL IS HERE BECAUSE THE STAFFER LOSES THEIRS. The portal requires
 *     active=true, so a deactivated staffer can no longer delete their own
 *     account — exactly when the retention justification starts expiring. This
 *     is the offboarding lever.
 *  4. THE OWNER IS TOLD THE VIEW IS LOGGED. Auditing someone quietly and
 *     telling them are different products.
 */
import { useState } from "react";
import { Eye, EyeOff, Landmark, Loader2, Trash2 } from "lucide-react";

import api from "../services/api";
import { useConfirm } from "../hooks/useConfirm";
import { useLanguage } from "../hooks/useLanguage";

export default function StaffBankRow({ memberId, memberName, labelCls }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [data, setData] = useState(null);   // null = not fetched yet
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reveal = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.get(`/staff/members/${memberId}/bank`);
      setData(r.data);
    } catch (e) {
      setErr(
        e?.response?.status === 403
          ? t("staffBankOwnerOnly", "Only the account owner can see bank details.")
          : t("staffBankLoadFailed", "Couldn't load the account."),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const yes = await confirm({
      title: t("staffBankRemoveTitle", "Remove bank account?"),
      message: t(
        "staffBankRemoveBody",
        "{name}'s account will be deleted. They can add it again from their portal while they are active.",
        { name: memberName || t("staffThisMember", "This staff member") },
      ),
      confirmLabel: t("remove", "Remove"),
      destructive: true,
    });
    if (!yes) return;
    setBusy(true); setErr("");
    try {
      await api.delete(`/staff/members/${memberId}/bank`);
      setData({ has_bank: false });
    } catch {
      setErr(t("staffBankRemoveFailed", "Couldn't remove the account."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sm:col-span-2">
      <span className={labelCls}>
        <span className="inline-flex items-center gap-1.5">
          <Landmark className="w-3 h-3" /> {t("staffBankLabel", "Bank account")}
        </span>
      </span>

      <div className="mt-1 flex items-center gap-2 flex-wrap">
        {data === null && (
          <button
            type="button"
            onClick={reveal}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            {t("staffBankShow", "Show account")}
          </button>
        )}

        {data && !data.has_bank && (
          <span className="text-[13px] text-gray-500 dark:text-gray-400">
            {t("staffBankNotGiven", "Not provided yet — they add it in their portal.")}
          </span>
        )}

        {data?.has_bank && (
          <>
            <span className="text-[14px] font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
              {data.reg_nr} – {data.account_number}
            </span>
            <button
              type="button"
              onClick={() => setData(null)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-semibold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              <EyeOff className="w-3.5 h-3.5" /> {t("staffBankHide", "Hide")}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> {t("remove", "Remove")}
            </button>
          </>
        )}
      </div>

      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}

      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
        {data?.has_bank
          ? t("staffBankViewLogged", "Viewing an account is recorded in the audit log.")
          : t("staffBankHint", "Staff enter this themselves. You can view or remove it — only they can change it.")}
      </p>
    </div>
  );
}
