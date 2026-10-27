// GuestSpinner — the wait on a restaurant guest's page, when there is one.
//
// A cold /r/<slug> load showed a BLUE app spinner at ~210 ms, a grey one at
// ~226 ms and then the skeleton at ~530 ms: four looks in under a second,
// and blue is not a BonBox colour (judge 24 Oct, refined A7). Here the
// spinner is grey and stays invisible for the first 600 ms (`.bb-late` in
// index.css), so a normal load goes straight from blank to the page and only
// a genuinely slow one shows that something is coming.
//
// Language-free on purpose: it renders before the guest's language is known.
export default function GuestSpinner({ fill = "min-h-screen", testId }) {
  return (
    <div data-testid={testId} className={`${fill} flex items-center justify-center bg-white dark:bg-gray-950`}>
      <div className="bb-late" data-late="600">
        <div className="w-6 h-6 rounded-full border-2 border-gray-200 border-t-gray-500 dark:border-gray-700 dark:border-t-gray-400 animate-spin" aria-hidden="true" />
      </div>
      <span className="sr-only">…</span>
    </div>
  );
}
