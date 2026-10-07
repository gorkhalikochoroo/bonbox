import { describe, it, expect, vi } from "vitest";
import {
  closeEmailState, emailErrorKey, filenameFromResponse, newSendKey, resendCloseEmail, sentWhen,
} from "../utils/closeEmail";

const profile = { accountant_email: "anna@revisor.dk" };

describe("closeEmailState — what History says about one close's lock mail", () => {
  it("reached the revisor only when the revisor is among the recipients", () => {
    expect(closeEmailState({ status: "sent", sentTo: ["owner@x.dk", "anna@revisor.dk"], profile }).kind).toBe("revisor");
    expect(closeEmailState({ status: "sent", sentTo: ["owner@x.dk"], profile }).kind).toBe("owner_only");
  });
  it("a failed send is 'failed' — including the legacy queued_retry, which never retried", () => {
    for (const status of ["send_failed", "queued_retry", "failed_skipped"]) {
      expect(closeEmailState({ status, sentTo: [], profile }).kind).toBe("failed");
    }
  });
  it("an opted-out revisor is named as such, never as a failure to retry", () => {
    expect(closeEmailState({ status: "sent", sentTo: ["owner@x.dk"], profile: { ...profile, accountant_opted_out: true } }).kind).toBe("opted_out");
  });
  it("says nothing when it does not know (old closes, Free)", () => {
    expect(closeEmailState({ status: null, profile }).kind).toBe("none");
    expect(closeEmailState({ status: "skipped_feature_locked", profile }).kind).toBe("none");
  });
});

describe("resend", () => {
  it("posts to the resend endpoint with one key per click and no interceptor replay", async () => {
    const api = { post: vi.fn().mockResolvedValue({ data: {} }) };
    const key = newSendKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await resendCloseEmail(api, "c1", { key, force: false });
    expect(api.post).toHaveBeenCalledWith("/daily-close/c1/resend-email", { key, force: false }, { _noRetry: true });
  });
  it("names the real cause, not 'this environment' for everything", () => {
    expect(emailErrorKey("pdf_build_failed")).toBe("dcMailErrPdf");
    expect(emailErrorKey("email_not_configured")).toBe("dcMailErrNotConfigured");
    expect(emailErrorKey("send_error: RuntimeError")).toBe("dcMailErrProvider");
  });
});

describe("file names and times", () => {
  it("reads the server's file name, æ/ø/å and the en dash intact", () => {
    const res = { headers: { "content-disposition": "attachment; filename=\"Kasserapporter Cafe Oersted 2026-09-01-2026-09-30.xlsx\"; filename*=UTF-8''Kasserapporter%20Caf%C3%A9%20%C3%98rsted%202026-09-01%E2%80%932026-09-30.xlsx" } };
    expect(filenameFromResponse(res, "x")).toBe("Kasserapporter Café Ørsted 2026-09-01–2026-09-30.xlsx");
    expect(filenameFromResponse({ headers: {} }, "fallback.pdf")).toBe("fallback.pdf");
  });
  it("reads a naive server timestamp as UTC", () => {
    const w = sentWhen("2026-10-08T05:12:00");
    expect(w.time).toMatch(/^\d\d:\d\d$/);
    expect(sentWhen(null)).toBeNull();
  });
});
