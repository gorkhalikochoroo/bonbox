import { createContext, useContext, useState } from "react";

const LanguageContext = createContext(null);

const translations = {
  en: {
    dashboard: "Dashboard", sales: "Sales", expenses: "Expenses", inventory: "Inventory",
    smartStaffing: "Smart Staffing", wasteTracker: "Waste Tracker", weeklyReport: "Weekly Report",
    momsVat: "Tax/VAT", darkMode: "Dark Mode", lightMode: "Light Mode", signOut: "Sign Out",
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
    // VAT — these are now generic fallbacks; currency-specific terms come from getVatTerms()
    vatReport: "Tax Report", salesSection: "Sales",
    salesInclVat: "Sales incl. Tax", salesExclVat: "Sales excl. Tax",
    outputVat: "Output Tax", expensesSection: "Expenses",
    expensesInclVat: "Expenses incl. Tax",
    expensesExclVat: "Expenses excl. Tax",
    inputVat: "Input Tax", vatPayable: "Tax Payable",
    payableToSkat: "Amount payable to tax authority", refundFromSkat: "Tax refund",
    loadingVat: "Loading tax report...", vatError: "Could not load tax report.",
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
    // Feedback
    feedback: "Feedback", sendFeedback: "Send Feedback", yourFeedback: "Your Feedback",
    feedbackSent: "Thank you for your feedback!", rateExperience: "Rate your experience",
    feedbackMessage: "Tell us what you think...", bugReport: "Bug Report",
    featureRequest: "Feature Request", generalFeedback: "General Feedback",
    complaint: "Complaint", praise: "Praise", noFeedbackYet: "No feedback submitted yet",
    stars: "stars",
    // Cash Book
    cashBook: "Cash Book",
    // Contact
    contact: "Contact",
    // Recently Deleted
    recentlyDeleted: "Recently Deleted",
    // Profile
    profile: "Profile",
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
    // VAT — generic Danish fallbacks; currency-specific terms come from getVatTerms()
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
    // Feedback
    feedback: "Tilbagemelding", sendFeedback: "Send tilbagemelding", yourFeedback: "Din tilbagemelding",
    feedbackSent: "Tak for din tilbagemelding!", rateExperience: "Bedøm din oplevelse",
    feedbackMessage: "Fortæl os hvad du synes...", bugReport: "Fejlrapport",
    featureRequest: "Funktionsønske", generalFeedback: "Generel tilbagemelding",
    complaint: "Klage", praise: "Ros", noFeedbackYet: "Ingen tilbagemelding endnu",
    stars: "stjerner",
    // Cash Book
    cashBook: "Kassebog",
    // Contact
    contact: "Kontakt",
    // Recently Deleted
    recentlyDeleted: "Nyligt slettet",
    profile: "Profil",
  },
  np: {
    dashboard: "ड्यासबोर्ड", sales: "बिक्री", expenses: "खर्च", inventory: "स्टक",
    smartStaffing: "स्मार्ट स्टाफिङ", wasteTracker: "फोहोर ट्र्याकर", weeklyReport: "हप्ताको रिपोर्ट",
    momsVat: "भ्याट", darkMode: "डार्क मोड", lightMode: "लाइट मोड", signOut: "लग आउट",
    language: "भाषा",
    // Dashboard
    welcome: "स्वागतम", todayRevenue: "आजको आम्दानी", monthlyProfit: "मासिक नाफा",
    topExpense: "सबैभन्दा ठूलो खर्च", inventoryAlerts: "स्टक अलर्ट", snapReceipt: "रसिद खिच्नुहोस्",
    repeatYesterday: "हिजोको बिक्री दोहोर्‍याउनुहोस्", downloadPdf: "PDF रिपोर्ट डाउनलोड",
    loadingDashboard: "ड्यासबोर्ड लोड हुँदैछ...", vsYesterday: "हिजोको तुलनामा", margin: "मार्जिन",
    none: "छैन", revenueTrend: "आम्दानीको प्रवृत्ति", expenseBreakdown: "खर्चको विवरण",
    noRevenueData: "अहिलेसम्म आम्दानी डाटा छैन", noExpenseData: "अहिलेसम्म खर्च डाटा छैन",
    recentReceipts: "हालका रसिदहरू", dailyGoal: "दैनिक लक्ष्य", reached: "पुग्यो!",
    setDailyGoal: "दैनिक आम्दानीको लक्ष्य राख्नुहोस्", trackProgress: "दिनभरको प्रगति ट्र्याक गर्नुहोस्",
    setGoal: "लक्ष्य राख्नुहोस्", editGoal: "लक्ष्य सम्पादन", save: "सेभ", cancel: "रद्द",
    yesterdayCopied: "हिजोको बिक्री आजमा कपी भयो!", noYesterdaySale: "हिजोको बिक्री भेटिएन",
    // Sales
    salesTracker: "बिक्री ट्र्याकर", logSale: "आजको बिक्री राख्नुहोस्",
    tapAmount: "रकम छान्नुहोस् वा आफ्नो टाइप गर्नुहोस्", customAmount: "आफ्नो रकम...", log: "राख्नुहोस्",
    recentSales: "हालका बिक्रीहरू", date: "मिति", amount: "रकम", payment: "भुक्तानी",
    noSalesYet: "अहिलेसम्म बिक्री छैन — माथि रकम थिच्नुहोस्!",
    importCsv: "CSV बाट आयात", csvColumns: "स्तम्भहरू: date, amount, payment_method (ऐच्छिक)",
    uploading: "अपलोड हुँदैछ...", chooseFile: "फाइल छान्नुहोस्",
    salesImported: "बिक्री आयात भयो", rowsSkipped: "पङ्क्ति छोडियो",
    // Expenses
    expenseTracker: "खर्च ट्र्याकर", addExpense: "खर्च थप्नुहोस्",
    pickCategory: "कोटि छान्नुहोस्, विवरण लेख्नुहोस्, रकम थिच्नुहोस्",
    whatWasIt: "के थियो? (जस्तै: गोलभेडा, बिजुलीको बिल)", add: "थप्नुहोस्",
    recentExpenses: "हालका खर्चहरू", description: "विवरण",
    noExpensesYet: "अहिलेसम्म खर्च छैन — कोटि छानेर माथि थप्नुहोस्!",
    firstTimeSetup: "पहिलो पटक? एक थिचाइमा सामान्य कोटिहरू सेटअप गर्नुहोस्",
    setupCategories: "कोटिहरू सेटअप",
    // Inventory
    inventoryMonitor: "स्टक मनिटर", lowStockAlerts: "कम स्टक अलर्ट",
    addItem: "सामान थप्नुहोस्", itemName: "सामानको नाम", quantity: "परिमाण", unit: "इकाई",
    costPerUnit: "प्रति इकाई मूल्य", threshold: "न्यूनतम सीमा",
    pieces: "थान", kg: "केजी", liters: "लिटर", boxes: "बाकस",
    noInventoryYet: "अहिलेसम्म स्टकमा सामान छैन",
    // Staffing
    analyzingPatterns: "बिक्री ढाँचा विश्लेषण हुँदैछ...", notEnoughData: "अहिलेसम्म पर्याप्त बिक्री डाटा छैन",
    logMoreSales: "पूर्वानुमानको लागि कम्तिमा केही हप्ताको बिक्री राख्नुहोस्",
    slowDaysAhead: "सुस्त दिनहरू आउँदैछन्", reduceStaff: "कर्मचारी घटाउनुहोस्, कम तयारी गर्नुहोस्",
    normalDays: "सामान्य दिनहरू", standardStaffing: "सामान्य स्टाफिङ",
    busyDaysAhead: "व्यस्त दिनहरू आउँदैछन्", extraStaff: "थप कर्मचारी चाहिन्छ",
    revenueForecast: "आम्दानी पूर्वानुमान र सिफारिस स्टाफ", salesPatterns: "तपाईंको बिक्री ढाँचा",
    predictedRevenue: "अनुमानित आम्दानी", day: "दिन", level: "स्तर",
    staffNeeded: "चाहिने कर्मचारी", confidence: "विश्वसनीयता", staffingRules: "स्टाफिङ नियमहरू",
    staffingRulesDesc: "विभिन्न आम्दानी स्तरमा कति कर्मचारी चाहिन्छ भनेर तोक्नुहोस्।",
    addRule: "नियम थप्नुहोस्", remove: "हटाउनुहोस्", staff: "कर्मचारी",
    next7days: "अर्को ७ दिन", next14days: "अर्को १४ दिन", next30days: "अर्को ३० दिन",
    totalStaffNeeded: "कुल चाहिने कर्मचारी", basedOnPatterns: "अनुमानित आम्दानी ढाँचामा आधारित",
    minRevenue: "न्यूनतम आम्दानी", maxRevenue: "अधिकतम आम्दानी",
    slow: "सुस्त", normal: "सामान्य", busy: "व्यस्त",
    // Waste
    logWaste: "फोहोर राख्नुहोस्", trackWaste: "के फालियो ट्र्याक गर्नुहोस्",
    wasteLogged: "फोहोर रेकर्ड भयो!", monthlyWasteCost: "मासिक फोहोर खर्च",
    itemsWasted: "फालिएका सामानहरू", noDataYet: "अहिलेसम्म डाटा छैन",
    whatWasWasted: "के फालियो? (जस्तै: कुखुराको मासु)", qty: "परिमाण",
    estimatedCost: "अनुमानित मूल्य", customCost: "आफ्नो मूल्य...",
    recentWaste: "हालको फोहोर", item: "सामान", reason: "कारण", cost: "मूल्य",
    noWasteYet: "अहिलेसम्म फोहोर रेकर्ड छैन",
    expired: "म्याद सकियो", overcooked: "बढी पाकेको", damaged: "बिग्रेको", other: "अन्य",
    // Weekly Report
    weeklySalesReport: "हप्ताको बिक्री रिपोर्ट", dailyAvg: "दैनिक औसत",
    daysRecorded: "रेकर्ड गरिएका दिन", bestDay: "सबैभन्दा राम्रो दिन", slowestDay: "सबैभन्दा सुस्त दिन",
    revenue: "आम्दानी", vsLastWeek: "गत हप्ताको तुलनामा",
    loadingReport: "रिपोर्ट लोड हुँदैछ...", noSalesData: "अहिलेसम्म बिक्री डाटा उपलब्ध छैन।",
    // VAT
    vatReport: "कर रिपोर्ट", salesSection: "बिक्री",
    salesInclVat: "भ्याट सहित बिक्री", salesExclVat: "भ्याट बिना बिक्री",
    outputVat: "आउटपुट भ्याट", expensesSection: "खर्च",
    expensesInclVat: "भ्याट सहित खर्च", expensesExclVat: "भ्याट बिना खर्च",
    inputVat: "इनपुट भ्याट", vatPayable: "तिर्नुपर्ने भ्याट",
    payableToSkat: "कर कार्यालयलाई तिर्नुपर्ने रकम", refundFromSkat: "कर कार्यालयबाट फिर्ता हुने रकम",
    loadingVat: "कर रिपोर्ट लोड हुँदैछ...", vatError: "कर रिपोर्ट लोड गर्न सकिएन।",
    // Receipt
    uploadReceipt: "रसिदको फोटो अपलोड गर्नुहोस्", takePhoto: "फोटो खिच्नुहोस्",
    photoOrGallery: "फोटो खिच्नुहोस् वा ग्यालरीबाट छान्नुहोस्", scanningReceipt: "रसिद स्क्यान हुँदैछ...",
    detectedAmount: "पत्ता लागेको रकम", couldntRead: "रकम पढ्न सकिएन — तल आफैं टाइप गर्नुहोस्",
    ocrNotAvailable: "OCR उपलब्ध छैन — रकम आफैं टाइप गर्नुहोस्",
    enterTotal: "कुल रकम लेख्नुहोस्...", confirmLog: "पुष्टि गरी बिक्री राख्नुहोस्",
    saleLoggedReceipt: "रसिदबाट बिक्री रेकर्ड भयो!",
    // Quick Add
    quickEntry: "छिटो एन्ट्री", logSaleTab: "बिक्री राख्नुहोस्", addExpenseTab: "खर्च थप्नुहोस्",
    quickAmount: "छिटो रकम", orTypeAmount: "वा रकम टाइप गर्नुहोस्...",
    category: "कोटि", addCategoriesFirst: "पहिले खर्च पेजमा कोटिहरू थप्नुहोस्",
    whatForExpense: "के को लागि थियो? (जस्तै: गोलभेडा)",
    saleLogged: "बिक्री रेकर्ड भयो!", expenseAdded: "खर्च थपियो!",
    // Forecast
    revenueForecastTitle: "आम्दानी पूर्वानुमान", nextDays: "अर्को ७ दिन",
    predictedTotal: "अनुमानित जम्मा", avgDaily: "औसत/दिन",
    trendUp: "बढ्दो", trendDown: "घट्दो", trendStable: "स्थिर",
    forecastConfidence: "विश्वसनीयता", noForecastData: "पूर्वानुमानको लागि थप बिक्री डाटा चाहिन्छ",
    predicted: "अनुमानित", actual: "वास्तविक",
    // Feedback
    feedback: "प्रतिक्रिया", sendFeedback: "प्रतिक्रिया पठाउनुहोस्", yourFeedback: "तपाईंको प्रतिक्रिया",
    feedbackSent: "प्रतिक्रियाको लागि धन्यवाद!", rateExperience: "आफ्नो अनुभव मूल्याङ्कन गर्नुहोस्",
    feedbackMessage: "तपाईंको विचार लेख्नुहोस्...", bugReport: "बग रिपोर्ट",
    featureRequest: "फिचर अनुरोध", generalFeedback: "सामान्य प्रतिक्रिया",
    complaint: "उजुरी", praise: "प्रशंसा", noFeedbackYet: "अहिलेसम्म प्रतिक्रिया छैन",
    stars: "तारा",
    // Cash Book
    cashBook: "खाता",
    // Contact
    contact: "सम्पर्क",
    // Recently Deleted
    recentlyDeleted: "हालै मेटाइएको",
    // Profile
    profile: "प्रोफाइल",
  },
};

const LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "da", label: "Dansk", flag: "🇩🇰" },
  { code: "np", label: "नेपाली", flag: "🇳🇵" },
];

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem("lang") || "en");

  const setLang = (code) => {
    setLangState(code);
    localStorage.setItem("lang", code);
  };

  // Keep toggleLang for backward compat — cycles through all languages
  const toggleLang = () => {
    const codes = LANGUAGES.map((l) => l.code);
    const idx = codes.indexOf(lang);
    const next = codes[(idx + 1) % codes.length];
    setLang(next);
  };

  const t = (key) => translations[lang]?.[key] || translations.en[key] || key;

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggleLang, t, LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
