import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const STORAGE_KEY = "bonbox_onboarding_dismissed";

export default function Onboarding({ summary }) {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true"
  );

  if (dismissed) return null;
  if (!summary) return null;
  if (summary.total_sales >= 5) return null;

  const dailyGoal = user?.daily_goal || 0;

  const steps = [
    {
      label: "Log your first sale",
      to: "/sales",
      done: summary.total_sales > 0,
    },
    {
      label: "Set up expense categories",
      to: "/expenses",
      done: summary.has_expense_categories,
    },
    {
      label: "Add inventory items",
      to: "/inventory",
      done: summary.has_inventory_items,
    },
    {
      label: "Set your daily goal",
      to: null,
      done: dailyGoal > 0,
    },
  ];

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
            Welcome to BonBox! Let's get you started.
          </h2>
          <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
            Complete these steps to set up your dashboard.
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium shrink-0 ml-4"
        >
          Dismiss
        </button>
      </div>

      <ul className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-3">
            {step.done ? (
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 text-sm font-bold">
                &#10003;
              </span>
            ) : (
              <span className="flex items-center justify-center w-6 h-6 rounded-full border-2 border-blue-300 dark:border-blue-600" />
            )}
            {step.to ? (
              <Link
                to={step.to}
                className={`text-sm font-medium ${
                  step.done
                    ? "text-gray-500 dark:text-gray-400 line-through"
                    : "text-blue-600 dark:text-blue-400 hover:underline"
                }`}
              >
                {step.label}
              </Link>
            ) : (
              <span
                className={`text-sm font-medium ${
                  step.done
                    ? "text-gray-500 dark:text-gray-400 line-through"
                    : "text-blue-600 dark:text-blue-400"
                }`}
              >
                {step.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
