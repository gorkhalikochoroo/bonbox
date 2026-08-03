/**
 * OwnerChatDrawer — the owner side of the 1:1 "Beskeder" channel.
 *
 * A slide-over panel launched from the schedule page. Master-detail in a single
 * column (works on phone + desktop): the thread list drills into a conversation
 * with a back arrow. Self-contained — it owns its own fetches via the
 * session-auth `api`, mirroring the staff portal's MessagesTab.
 *
 * Honesty: optimistic sends show a pending bubble; a failed send is tappable to
 * refill the composer (no silent retry). No counts are shown that aren't real.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { X, Send, MessageSquare, ChevronLeft, Users, Plus, Check } from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { PhotoGrid, PendingPhotos, AttachButton, usePhotoPicker } from "./chatPhotoKit";

function timeAgo(dateStr) {
  if (!dateStr) return "";
  try {
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : `${dateStr}Z`;
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return "nu";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}t`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function Conversation({ endpoint, name, sub, isGroup, onBack, onRead }) {
  const { t } = useLanguage();
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const picker = usePhotoPicker();
  const scrollRef = useRef(null);

  const load = useCallback(
    (markRead = true) => {
      api
        .get(endpoint)
        .then((res) => {
          setMessages(res.data.messages || []);
          if (markRead) onRead?.();
        })
        .catch(() => setMessages((prev) => prev || []));
    },
    [endpoint, onRead],
  );

  useEffect(() => {
    load(true);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 6000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const body = text.trim();
    const photoFiles = picker.files.map((f) => f.file);
    if ((!body && photoFiles.length === 0) || sending) return;
    setSending(true);
    const cmid =
      (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
      `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const localPreviews = picker.files.map((f) => f.preview);
    const optimistic = {
      id: `tmp-${cmid}`,
      sender_type: "owner",
      mine: true,
      body: body || null,
      photo_count: photoFiles.length,
      _localPreviews: localPreviews,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages((prev) => [...(prev || []), optimistic]);
    setText("");
    picker.clear();
    try {
      let res;
      if (photoFiles.length > 0) {
        const fd = new FormData();
        if (body) fd.append("body", body);
        fd.append("client_msg_id", cmid);
        photoFiles.forEach((file) => fd.append("photos", file));
        res = await api.post(`${endpoint}/photos`, fd);
      } else {
        res = await api.post(endpoint, {
          body,
          client_msg_id: cmid,
        });
      }
      setMessages((prev) =>
        (prev || []).map((m) => (m.id === optimistic.id ? res.data : m)),
      );
    } catch {
      setMessages((prev) =>
        (prev || []).map((m) =>
          m.id === optimistic.id ? { ...m, _pending: false, _failed: true } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300"
          aria-label={t("staffChatBack", "Back")}
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2} aria-hidden />
        </button>
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">{name}</div>
          {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
        </div>
      </div>

      {/* Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages === null ? (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={`h-9 rounded-2xl bg-gray-100 dark:bg-gray-700 ${i % 2 ? "w-2/3" : "w-1/2 ml-auto"}`}
              />
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
            <p className="text-sm text-gray-500">
              {t("ownerChatEmptyBody", "No messages yet. Say hi 👋")}
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[78%] flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
                {isGroup && !m.mine && m.sender_name && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 px-1 mb-0.5">
                    {m.sender_name}
                  </span>
                )}
                {(m.photo_count > 0 || m._localPreviews) && (
                  <div className={m._pending ? "opacity-60" : ""}>
                    <PhotoGrid client={api} photos={m.photos} localPreviews={m._localPreviews} />
                  </div>
                )}
                {m.body && (
                  <div
                    onClick={
                      m._failed
                        ? () => {
                            setText(m.body);
                            setMessages((prev) => (prev || []).filter((x) => x.id !== m.id));
                          }
                        : undefined
                    }
                    className={`px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                      m.mine
                        ? "text-white rounded-br-md"
                        : "bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-bl-md"
                    } ${m._pending ? "opacity-60" : ""} ${m._failed ? "cursor-pointer ring-1 ring-red-300" : ""}`}
                    style={m.mine ? { background: "rgb(var(--brand-600))" } : undefined}
                  >
                    {m.body}
                  </div>
                )}
                <span className="text-[10px] text-gray-400 mt-0.5 px-1">
                  {m._failed
                    ? t("staffChatFailed", "Not sent — tap to retry")
                    : timeAgo(m.created_at)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="px-3 pt-2 border-t border-gray-200 dark:border-gray-700 shrink-0">
        <PendingPhotos picker={picker} />
        <div className="pb-2 flex items-end gap-1.5">
          <AttachButton picker={picker} label={t("staffChatAddPhoto", "Add photo")} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t("staffChatPlaceholder", "Write a message…")}
            className="flex-1 resize-none max-h-28 px-3 py-2 rounded-2xl bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
          />
          <button
            onClick={send}
            disabled={(!text.trim() && picker.files.length === 0) || sending}
            aria-label={t("staffChatSend", "Send")}
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white disabled:opacity-40 transition"
            style={{ background: "rgb(var(--brand-600))" }}
          >
            <Send className="w-[18px] h-[18px]" strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Owner-side group creation. The roster comes from the thread list the drawer
    already has, so this adds no new way to read staff records. */
function NewGroupSheet({ people, onClose, onCreated }) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const create = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/staff/chat/groups", { title: name, staff_ids: picked });
      onCreated(res.data);
    } catch {
      setError(t("ownerChatGroupFailed", "Could not create the group. Try again."));
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div className="font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />
          {t("ownerChatNewGroup", "New group")}
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300"
          aria-label={t("staffChatClose", "Close")}
        >
          <X className="w-5 h-5" strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="px-4 pt-3 shrink-0">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
          placeholder={t("ownerChatGroupNamePlaceholder", "e.g. Kitchen")}
          className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
        />
        <p className="mt-3 mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {t("ownerChatChoosePeople", "Who's in it?")}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-3">
        {people.length === 0 ? (
          <p className="text-sm text-gray-500 py-3">
            {t("ownerChatNoStaff", "Add staff to start a conversation.")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {people.map((pp) => {
              const on = picked.includes(pp.staff_id);
              return (
                <li key={pp.staff_id}>
                  <button
                    onClick={() => toggle(pp.staff_id)}
                    aria-pressed={on}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition ${
                      on
                        ? "border-green-300 bg-green-50 dark:bg-green-900/20"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                    }`}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {pp.name}
                      </span>
                      {pp.role && (
                        <span className="block text-[11px] text-gray-500 truncate">{pp.role}</span>
                      )}
                    </span>
                    {on && <Check className="w-4 h-4 text-green-600 shrink-0" strokeWidth={2.6} aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-700 shrink-0">
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <button
          onClick={create}
          disabled={!title.trim() || busy}
          className="w-full h-11 rounded-xl text-white text-sm font-semibold disabled:opacity-40 transition"
          style={{ background: "rgb(var(--brand-600))" }}
        >
          {t("ownerChatCreateGroup", "Create group")}
        </button>
      </div>
    </div>
  );
}

export default function OwnerChatDrawer({ open, onClose, onUnreadChange }) {
  const { t } = useLanguage();
  const [threads, setThreads] = useState(null);
  const [groups, setGroups] = useState([]);
  const [active, setActive] = useState(null); // {endpoint, name, sub, isGroup}
  const [creating, setCreating] = useState(false);

  // People and groups are two reads because they are two shapes; the badge is
  // the SUM, so a group nobody has answered still shows on the launcher.
  const loadThreads = useCallback(() => {
    Promise.all([
      api.get("/staff/chat/threads").then((r) => r.data.threads || []).catch(() => []),
      api.get("/staff/chat/groups").then((r) => r.data.groups || []).catch(() => []),
    ]).then(([people, grps]) => {
      setThreads(people);
      setGroups(grps);
      onUnreadChange?.(
        [...people, ...grps].reduce((s, r) => s + (r.unread || 0), 0),
      );
    });
  }, [onUnreadChange]);

  useEffect(() => {
    if (!open) return;
    loadThreads();
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !active) loadThreads();
    }, 8000);
    return () => clearInterval(id);
  }, [open, active, loadThreads]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      {/* Scrim */}
      <button
        className="absolute inset-0 bg-gray-900/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label={t("staffChatClose", "Close")}
      />
      {/* Panel */}
      <div className="relative w-full sm:max-w-md h-full bg-gray-50 dark:bg-gray-900 shadow-2xl flex flex-col">
        {active ? (
          <Conversation
            endpoint={active.endpoint}
            name={active.name}
            sub={active.sub}
            isGroup={active.isGroup}
            onBack={() => {
              setActive(null);
              loadThreads();
            }}
            onRead={loadThreads}
          />
        ) : (
          <>
            {/* List header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <div className="font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />
                {t("ownerChatTitle", "Messages")}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCreating(true)}
                  className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300"
                  aria-label={t("ownerChatNewGroup", "New group")}
                  title={t("ownerChatNewGroup", "New group")}
                >
                  <Plus className="w-5 h-5" strokeWidth={2.2} aria-hidden />
                </button>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300"
                  aria-label={t("staffChatClose", "Close")}
                >
                  <X className="w-5 h-5" strokeWidth={2} aria-hidden />
                </button>
              </div>
            </div>

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto">
              {threads === null ? (
                <div className="p-3 space-y-2 animate-pulse">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-14 rounded-xl bg-gray-100 dark:bg-gray-800" />
                  ))}
                </div>
              ) : threads.length === 0 && groups.length === 0 ? (
                <div className="text-center py-16 px-6">
                  <MessageSquare className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
                  <p className="text-sm text-gray-500">
                    {t("ownerChatNoStaff", "Add staff to start a conversation.")}
                  </p>
                </div>
              ) : (
                <>
                {groups.length > 0 && (
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {groups.map((g) => (
                      <li key={g.thread_id}>
                        <button
                          onClick={() =>
                            setActive({
                              endpoint: `/staff/chat/groups/${g.thread_id}`,
                              name: g.title,
                              sub: t("ownerChatMemberCount", "{n} people").replace(
                                "{n}", String(g.member_count || 0),
                              ),
                              isGroup: true,
                            })
                          }
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white dark:hover:bg-gray-800 transition"
                        >
                          <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-gray-900 dark:bg-gray-700 text-white">
                            <Users className="w-4 h-4" strokeWidth={2.2} aria-hidden />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                {g.title}
                              </span>
                              <span className="text-[10px] text-gray-400 shrink-0">
                                {timeAgo(g.last_message_at)}
                              </span>
                            </div>
                            <div className="text-[12px] text-gray-500 truncate">
                              {g.last_body
                                ? (g.last_sender ? `${g.last_sender}: ${g.last_body}` : g.last_body)
                                : t("ownerChatNoMsgPreview", "No messages yet")}
                            </div>
                          </div>
                          {g.unread > 0 && (
                            <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-[18px] text-center">
                              {g.unread > 9 ? "9+" : g.unread}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {threads.map((thr) => (
                    <li key={thr.staff_id}>
                      <button
                        onClick={() =>
                          setActive({
                            endpoint: `/staff/chat/threads/${thr.staff_id}`,
                            name: thr.name,
                            sub: thr.role || null,
                            isGroup: false,
                          })
                        }
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white dark:hover:bg-gray-800 transition"
                      >
                        <div
                          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white"
                          style={{ background: "rgb(var(--brand-500))" }}
                        >
                          {(thr.name || "?").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {thr.name}
                            </span>
                            <span className="text-[10px] text-gray-400 shrink-0">
                              {timeAgo(thr.last_message_at)}
                            </span>
                          </div>
                          <div className="text-[12px] text-gray-500 truncate">
                            {thr.last_body || t("ownerChatNoMsgPreview", "No messages yet")}
                          </div>
                        </div>
                        {thr.unread > 0 && (
                          <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-[18px] text-center">
                            {thr.unread > 9 ? "9+" : thr.unread}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                </>
              )}
            </div>
            {creating && (
              <NewGroupSheet
                people={threads || []}
                onClose={() => setCreating(false)}
                onCreated={(g) => {
                  setCreating(false);
                  loadThreads();
                  setActive({
                    endpoint: `/staff/chat/groups/${g.thread_id}`,
                    name: g.title,
                    sub: t("ownerChatMemberCount", "{n} people").replace(
                      "{n}", String((g.member_ids || []).length),
                    ),
                    isGroup: true,
                  });
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
