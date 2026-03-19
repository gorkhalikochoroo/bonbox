import { createContext, useContext, useState } from "react";

const LanguageContext = createContext(null);

const translations = {
  en: {
    dashboard: "Dashboard", sales: "Sales", expenses: "Expenses", inventory: "Inventory",
    smartStaffing: "Smart Staffing", wasteTracker: "Waste Tracker", weeklyReport: "Weekly Report",
    momsVat: "Moms/VAT", darkMode: "Dark Mode", lightMode: "Light Mode", signOut: "Sign Out",
    language: "Dansk",
    // Dashboard
    welcome: "Welcome", todayRevenue: "Today's Revenue", monthlyProfit: "Monthly Profit",
    topExpense: "Top Expense", inventoryAlerts: "Inventory Alerts", snapReceipt: "Snap Receipt",
    repeatYesterday: "Repeat Yesterday's Sale", downloadPdf: "Download PDF Report",
    loadingDashboard: "Loading dashboard...", vsYesterday: "vs yesterday", margin: "margin",
    none: "None", revenueTrend: "Revenue Trend", expenseBreakdown: "Expense Breakdown",
    noRevenueData: "No revenue data yet", noExpenseData: "No expense data yet",
    recentReceipts: "Recent Receipts", dailyGoal: "Daily Goal", reached: "Reached!",
    setDailyGoal: "Set a daily revenue goal", trackProgress: "Track progress throughout the day",
    setGoal: "Set Goal", editGoal: "Edit goal", save: "Save", cancel: "Cancel",
    yesterdayCopied: "Yesterday's sale copied to today!", noYesterdaySale: "No sale found for yesterday",
    // Sales
    salesTracker: "Sales Tracker", logSale: "Log Today's Sale",
    tapAmount: "Tap an amount or type your own", customAmount: "Custom amount...", log: "Log",
    recentSales: "Recent Sales", date: "Date", amount: "Amount", payment: "Payment",
    noSalesYet: "No sales yet — tap an amount above to start!",
    importCsv: "Import from CSV", csvColumns: "Columns: date, amount, payment_method (optional)",
    uploading: "Uploading...", chooseFile: "Choose File",
    salesImported: "sales imported", rowsSkipped: "rows skipped",
    // Expenses
    expenseTracker: "Expense Tracker", addExpense: "Add Expense",
    pickCategory: "Pick a category, describe it, tap an amount",
    whatWasIt: "What was it? (e.g. Tomatoes, Electric bill)", add: "Add",
    recentExpenses: "Recent Expenses", description: "Description",
    noExpensesYet: "No expenses yet — pick a category and add one above!",
    firstTimeSetup: "First time? Set up common categories in one tap",
    setupCategories: "Set Up Categories",
    // Inventory
    inventoryMonitor: "Inventory Monitor", lowStockAlerts: "Low Stock Alerts",
    addItem: "Add Item", itemName: "Item name", quantity: "Quantity", unit: "Unit",
    costPerUnit: "Cost/Unit", threshold: "Threshold",
    pieces: "Pieces", kg: "Kg", liters: "Liters", boxes: "Boxes",
    noInventoryYet: "No inventory items yet",
    // Staffing
    analyzingPatterns: "Analyzing sales patterns...", notEnoughData: "Not enough sales data yet",
    logMoreSales: "Log at least a few weeks of sales to enable predictions",
    slowDaysAhead: "Slow Days Ahead", reduceStaff: "Reduce staff, prep less",
    normalDays: "Normal Days", standardStaffing: "Standard staffing",
    busyDaysAhead: "Busy Days Ahead", extraStaff: "Extra staff needed",
    revenueForecast: "Revenue Forecast & Recommended Staff", salesPatterns: "Your Sales Patterns",
    predictedRevenue: "Predicted Revenue", day: "Day", level: "Level",
    staffNeeded: "Staff Needed", confidence: "Confidence", staffingRules: "Staffing Rules",
    staffingRulesDesc: "Define how many staff you need at different revenue levels.",
    addRule: "Add Rule", remove: "Remove", staff: "staff",
    next7days: "Next 7 days", next14days: "Next 14 days", next30days: "Next 30 days",
    totalStaffNeeded: "Total Staff Needed", basedOnPatterns: "Based on predicted revenue patterns",
    minRevenue: "Min revenue", maxRevenue: "Max revenue",
    slow: "Slow", normal: "Normal", busy: "Busy",
    // Waste
    logWaste: "Log Waste", trackWaste: "Track what gets thrown out",
    wasteLogged: "Waste logged!", monthlyWasteCost: "Monthly Waste Cost",
    itemsWasted: "Items Wasted", noDataYet: "No data yet",
    whatWasWasted: "What was wasted? (e.g. Chicken breast)", qty: "Qty",
    estimatedCost: "Estimated cost (DKK)", customCost: "Custom cost...",
    recentWaste: "Recent Waste", item: "Item", reason: "Reason", cost: "Cost",
    noWasteYet: "No waste logged yet",
    expired: "expired", overcooked: "overcooked", damaged: "damaged", other: "other",
    // Weekly Report
    weeklySalesReport: "Weekly Sales Report", dailyAvg: "Daily Avg",
    daysRecorded: "Days Recorded", bestDay: "Best Day", slowestDay: "Slowest Day",
    revenue: "Revenue", vsLastWeek: "vs last week",
    loadingReport: "Loading report...", noSalesData: "No sales data available yet.",
    // VAT
    vatReport: "Momsopgørelse / VAT Report", salesSection: "Salg (Sales)",
    salesInclVat: "Salg inkl. moms (Sales incl. VAT)", salesExclVat: "Salg ekskl. moms (Sales excl. VAT)",
    outputVat: "Udgående moms (Output VAT)", expensesSection: "Udgifter (Expenses)",
    expensesInclVat: "Udgifter inkl. moms (Expenses incl. VAT)",
    expensesExclVat: "Udgifter ekskl. moms (Expenses excl. VAT)",
    inputVat: "Indgående moms (Input VAT)", vatPayable: "Moms til betaling (VAT Payable)",
    payableToSkat: "Amount payable to SKAT", refundFromSkat: "Refund from SKAT",
    loadingVat: "Loading VAT report...", vatError: "Could not load VAT report.",
    // Receipt
    uploadReceipt: "Upload Receipt Photo", takePhoto: "Take Photo",
    photoOrGallery: "Take a photo or choose from gallery", scanningReceipt: "Scanning receipt...",
    detectedAmount: "Detected amount", couldntRead: "Couldn't read amount — type it manually below",
    ocrNotAvailable: "OCR not available — type the amount manually",
    enterTotal: "Enter total amount...", confirmLog: "Confirm & Log Sale",
    saleLoggedReceipt: "Sale logged from receipt!",
    // Quick Add
    quickEntry: "Quick Entry", logSaleTab: "Log Sale", addExpenseTab: "Add Expense",
    quickAmount: "Quick amount (DKK)", orTypeAmount: "Or type amount...",
    category: "Category", addCategoriesFirst: "Add categories in Expenses page first",
    whatForExpense: "What was it for? (e.g. Tomatoes)",
    saleLogged: "Sale logged!", expenseAdded: "Expense added!",
    // Forecast
    revenueForecastTitle: "Revenue Forecast", nextDays: "Next 7 Days",
    predictedTotal: "Predicted Total", avgDaily: "Avg/Day",
    trendUp: "Trending Up", trendDown: "Trending Down", trendStable: "Stable",
    forecastConfidence: "Confidence", noForecastData: "Need more sales data for predictions",
    predicted: "Predicted", actual: "Actual",
  },
  da: {
    dashboard: "Oversigt", sales: "Salg", expenses: "Udgifter", inventory: "Lager",
    smartStaffing: "Vagtplanlægning", wasteTracker: "Madspild", weeklyReport: "Ugerapport",
    momsVat: "Moms", darkMode: "Mørk tilstand", lightMode: "Lys tilstand", signOut: "Log ud",
    language: "English",
    // Dashboard
    welcome: "Velkommen", todayRevenue: "Dagens omsætning", monthlyProfit: "Månedens overskud",
    topExpense: "Største udgift", inventoryAlerts: "Lageradvarsler", snapReceipt: "Tag kvittering",
    repeatYesterday: "Gentag gårsdagens salg", downloadPdf: "Hent PDF-rapport",
    loadingDashboard: "Indlæser oversigt...", vsYesterday: "vs i går", margin: "margin",
    none: "Ingen", revenueTrend: "Omsætningsudvikling", expenseBreakdown: "Udgiftsfordeling",
    noRevenueData: "Ingen omsætningsdata endnu", noExpenseData: "Ingen udgiftsdata endnu",
    recentReceipts: "Seneste kvitteringer", dailyGoal: "Dagligt mål", reached: "Nået!",
    setDailyGoal: "Sæt et dagligt omsætningsmål", trackProgress: "Følg fremskridt i løbet af dagen",
    setGoal: "Sæt mål", editGoal: "Rediger mål", save: "Gem", cancel: "Annuller",
    yesterdayCopied: "Gårsdagens salg kopieret til i dag!", noYesterdaySale: "Intet salg fundet for i går",
    // Sales
    salesTracker: "Salgsregistrering", logSale: "Registrer dagens salg",
    tapAmount: "Tryk på et beløb eller skriv dit eget", customAmount: "Brugerdefineret beløb...",
    log: "Registrer", recentSales: "Seneste salg", date: "Dato", amount: "Beløb",
    payment: "Betaling", noSalesYet: "Ingen salg endnu — tryk på et beløb ovenfor!",
    importCsv: "Importer fra CSV", csvColumns: "Kolonner: dato, beløb, betalingsmetode (valgfri)",
    uploading: "Uploader...", chooseFile: "Vælg fil",
    salesImported: "salg importeret", rowsSkipped: "rækker sprunget over",
    // Expenses
    expenseTracker: "Udgiftsregistrering", addExpense: "Tilføj udgift",
    pickCategory: "Vælg en kategori, beskriv den, tryk på et beløb",
    whatWasIt: "Hvad var det? (f.eks. Tomater, Elregning)", add: "Tilføj",
    recentExpenses: "Seneste udgifter", description: "Beskrivelse",
    noExpensesYet: "Ingen udgifter endnu — vælg en kategori og tilføj ovenfor!",
    firstTimeSetup: "Første gang? Opret standardkategorier med ét tryk",
    setupCategories: "Opret kategorier",
    // Inventory
    inventoryMonitor: "Lageroversigt", lowStockAlerts: "Advarsler om lav beholdning",
    addItem: "Tilføj vare", itemName: "Varenavn", quantity: "Antal", unit: "Enhed",
    costPerUnit: "Pris/enhed", threshold: "Grænseværdi",
    pieces: "Styk", kg: "Kg", liters: "Liter", boxes: "Kasser",
    noInventoryYet: "Ingen lagervarer endnu",
    // Staffing
    analyzingPatterns: "Analyserer salgsmønstre...", notEnoughData: "Ikke nok salgsdata endnu",
    logMoreSales: "Registrer mindst et par ugers salg for at aktivere forudsigelser",
    slowDaysAhead: "Rolige dage forude", reduceStaff: "Reducer personale, forbered mindre",
    normalDays: "Normale dage", standardStaffing: "Standard bemanding",
    busyDaysAhead: "Travle dage forude", extraStaff: "Ekstra personale nødvendigt",
    revenueForecast: "Omsætningsprognose & anbefalet bemanding", salesPatterns: "Dine salgsmønstre",
    predictedRevenue: "Forventet omsætning", day: "Dag", level: "Niveau",
    staffNeeded: "Personale", confidence: "Sikkerhed", staffingRules: "Bemandingsregler",
    staffingRulesDesc: "Definer hvor mange ansatte du har brug for ved forskellige omsætningsniveauer.",
    addRule: "Tilføj regel", remove: "Fjern", staff: "personale",
    next7days: "Næste 7 dage", next14days: "Næste 14 dage", next30days: "Næste 30 dage",
    totalStaffNeeded: "Samlet personale nødvendigt", basedOnPatterns: "Baseret på forventede omsætningsmønstre",
    minRevenue: "Min. omsætning", maxRevenue: "Maks. omsætning",
    slow: "Rolig", normal: "Normal", busy: "Travl",
    // Waste
    logWaste: "Registrer spild", trackWaste: "Hold styr på hvad der smides ud",
    wasteLogged: "Spild registreret!", monthlyWasteCost: "Månedlig spildudgift",
    itemsWasted: "Varer smidt ud", noDataYet: "Ingen data endnu",
    whatWasWasted: "Hvad blev smidt ud? (f.eks. Kyllingebryst)", qty: "Antal",
    estimatedCost: "Anslået pris (DKK)", customCost: "Brugerdefineret pris...",
    recentWaste: "Seneste spild", item: "Vare", reason: "Årsag", cost: "Pris",
    noWasteYet: "Intet spild registreret endnu",
    expired: "udløbet", overcooked: "overkogt", damaged: "beskadiget", other: "andet",
    // Weekly Report
    weeklySalesReport: "Ugentlig salgsrapport", dailyAvg: "Dagligt gns.",
    daysRecorded: "Dage registreret", bestDay: "Bedste dag", slowestDay: "Langsomste dag",
    revenue: "Omsætning", vsLastWeek: "vs sidste uge",
    loadingReport: "Indlæser rapport...", noSalesData: "Ingen salgsdata tilgængelig endnu.",
    // VAT
    vatReport: "Momsopgørelse", salesSection: "Salg",
    salesInclVat: "Salg inkl. moms", salesExclVat: "Salg ekskl. moms",
    outputVat: "Udgående moms", expensesSection: "Udgifter",
    expensesInclVat: "Udgifter inkl. moms", expensesExclVat: "Udgifter ekskl. moms",
    inputVat: "Indgående moms", vatPayable: "Moms til betaling",
    payableToSkat: "Beløb der skal indbetales til SKAT", refundFromSkat: "Beløb til gode fra SKAT",
    loadingVat: "Indlæser momsrapport...", vatError: "Kunne ikke indlæse momsrapporten.",
    // Receipt
    uploadReceipt: "Upload kvitteringsbillede", takePhoto: "Tag billede",
    photoOrGallery: "Tag et billede eller vælg fra galleri", scanningReceipt: "Scanner kvittering...",
    detectedAmount: "Registreret beløb", couldntRead: "Kunne ikke læse beløb — skriv det manuelt nedenfor",
    ocrNotAvailable: "OCR ikke tilgængelig — skriv beløbet manuelt",
    enterTotal: "Indtast totalbeløb...", confirmLog: "Bekræft & registrer salg",
    saleLoggedReceipt: "Salg registreret fra kvittering!",
    // Quick Add
    quickEntry: "Hurtig registrering", logSaleTab: "Registrer salg", addExpenseTab: "Tilføj udgift",
    quickAmount: "Hurtigt beløb (DKK)", orTypeAmount: "Eller skriv beløb...",
    category: "Kategori", addCategoriesFirst: "Tilføj kategorier på udgiftssiden først",
    whatForExpense: "Hvad var det til? (f.eks. Tomater)",
    saleLogged: "Salg registreret!", expenseAdded: "Udgift tilføjet!",
    // Forecast
    revenueForecastTitle: "Omsætningsprognose", nextDays: "Næste 7 dage",
    predictedTotal: "Forventet total", avgDaily: "Gns./dag",
    trendUp: "Stigende", trendDown: "Faldende", trendStable: "Stabil",
    forecastConfidence: "Sikkerhed", noForecastData: "Flere salgsdata nødvendige for prognoser",
    predicted: "Forventet", actual: "Faktisk",
  },
};

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem("lang") || "en");

  const toggleLang = () => {
    const next = lang === "en" ? "da" : "en";
    setLang(next);
    localStorage.setItem("lang", next);
  };

  const t = (key) => translations[lang]?.[key] || translations.en[key] || key;

  return (
    <LanguageContext.Provider value={{ lang, toggleLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
