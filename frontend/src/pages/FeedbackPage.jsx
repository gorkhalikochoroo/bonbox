import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatDate, formatDateShort } from "../utils/dateFormat";

const CATEGORIES = ["bugReport", "featureRequest", "generalFeedback", "complaint", "praise"];

export default function FeedbackPage() {
  const { t } = useLanguage();
  const [feedbacks, setFeedbacks] = useState([]);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [category, setCategory] = useState("generalFeedback");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const fetchFeedback = () => {
    api.get("/feedback").then((res) => setFeedbacks(res.data)).catch(() => {});
  };

  useEffect(() => { fetchFeedback(); }, []);

  const submit = async () => {
    if (!rating || !message.trim()) return;
    setError("");
    try {
      await api.post("/feedback", {
        rating,
        category,
        message: message.trim(),
      });
      setRating(0);
      setMessage("");
      setCategory("generalFeedback");
      setSuccess(t("feedbackSent"));
      fetchFeedback();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Something went wrong");
      setTimeout(() => setError(""), 4000);
    }
  };

  const StarIcon = ({ filled, half }) => (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill={filled ? "#f59e0b" : "none"} stroke="#f59e0b" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  );

  const categoryLabel = (cat) => t(cat);

  const categoryBadgeColor = (cat) => {
    switch (cat) {
      case "bugReport": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
      case "featureRequest": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
      case "complaint": return "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400";
      case "praise": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
      default: return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("feedback")}</h1>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm font-medium">{error}</div>}

      {/* Feedback Form */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-1">{t("sendFeedback")}</h2>
        <p className="text-sm text-gray-400 mb-5">{t("rateExperience")}</p>

        {/* Star Rating */}
        <div className="flex items-center gap-1 mb-5">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onClick={() => setRating(star)}
              onMouseEnter={() => setHoverRating(star)}
              onMouseLeave={() => setHoverRating(0)}
              className="transition-transform hover:scale-110 focus:outline-none"
            >
              <StarIcon filled={(hoverRating || rating) >= star} />
            </button>
          ))}
          {rating > 0 && (
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
              {rating} {t("stars")}
            </span>
          )}
        </div>

        {/* Category Dropdown */}
        <div className="mb-4">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full md:w-auto px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{categoryLabel(cat)}</option>
            ))}
          </select>
        </div>

        {/* Message */}
        <div className="mb-4">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("feedbackMessage")}
            rows={4}
            className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {/* Submit */}
        <button
          onClick={submit}
          disabled={!rating || !message.trim()}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
        >
          {t("sendFeedback")}
        </button>
      </div>

      {/* Past Feedback List */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-200">{t("yourFeedback")}</h2>
        </div>

        {feedbacks.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400">{t("noFeedbackYet")}</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {feedbacks.map((fb) => (
              <div key={fb.id} className="px-6 py-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    {/* Stars display */}
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <svg key={star} className="w-4 h-4" viewBox="0 0 24 24" fill={fb.rating >= star ? "#f59e0b" : "none"} stroke="#f59e0b" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                        </svg>
                      ))}
                    </div>
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${categoryBadgeColor(fb.category)}`}>
                      {categoryLabel(fb.category)}
                    </span>
                  </div>
                  {fb.date && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">{formatDate(fb.date)}</span>
                  )}
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300">{fb.message}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
