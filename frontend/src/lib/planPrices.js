/**
 * The plan prices BonBox prints — ONE place for the landing page, the in-app
 * plan page (/subscription) and every upgrade nudge.
 *
 * Source of truth: backend/app/config.py PLAN_PRICES_DKK and
 * FOUNDING_MEMBER_LIMIT (the display mirror of the four Stripe Prices; the
 * charge itself always comes from the Stripe Price at checkout). A test
 * (landingPush9Claims) reads config.py and fails if these drift apart.
 *
 * The founding price is a real offer, not a sale: the first 100 paying
 * businesses get it and keep it while the subscription stays active (Terms,
 * "Stifterpris"). So every surface states it as "129 kr./md. — after the
 * first 100: 199 kr./md.", never as a struck-through "was 199" that nobody
 * ever paid (markedsføringsloven: a "before" price must be one that was
 * actually charged). Push 9 removed the strikethrough from the landing first;
 * the plan page and UpgradeNudge, where checkout actually starts, read from
 * here too so the three can never say different things.
 */
export const FOUNDING_LIMIT = 100;

export const PLAN_PRICES = {
  starter: { regular: 199, founding: 129 },
  pro: { regular: 349, founding: 249 },
};

/** The lowest paid price a new business can get today (the price line). */
export const FROM_PRICE = PLAN_PRICES.starter.founding;
