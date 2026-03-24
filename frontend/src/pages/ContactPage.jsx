export default function ContactPage() {
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Contact & Support</h1>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">Get in Touch</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Have questions, feedback, or need help? We'd love to hear from you.
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 rounded-lg flex items-center justify-center text-blue-600 dark:text-blue-400 text-lg">
              @
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Email</p>
              <a href="mailto:gorkhalikochoroo@gmail.com" className="text-blue-600 dark:text-blue-400 hover:underline text-sm">
                gorkhalikochoroo@gmail.com
              </a>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-50 dark:bg-purple-900/30 rounded-lg flex items-center justify-center text-purple-600 dark:text-purple-400 text-lg">
              *
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">In-App Feedback</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Use the <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = ""; }} className="text-blue-600 dark:text-blue-400 hover:underline">Feedback</a> page to rate features and share suggestions directly.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">About BonBox</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          BonBox is built by Manoj Chaudhary as part of a Master's thesis in Data-Driven Business Development
          at the University of Southern Denmark (SDU). It's designed for small businesses — restaurants, retail shops,
          clothing stores, cafes, and more — who need a simple, affordable way to track sales, expenses, cash flow, and inventory.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-500 mt-3">
          Based in Copenhagen, Denmark
        </p>
      </div>
    </div>
  );
}
