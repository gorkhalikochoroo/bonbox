# Adding a New Feature

## Backend
1. Add model fields to `backend/app/models.py`
2. Add schema fields to `backend/app/schemas.py`
3. Add `ALTER TABLE` migration to `_migrations` list in `backend/app/main.py`
4. Add/update router in `backend/app/routers/`
5. Register router in `main.py` if new

## Frontend
1. Create page in `frontend/src/pages/`
2. Add route in `frontend/src/App.jsx` (use `lazyRetry()` for lazy loading)
3. Add nav item in `frontend/src/components/Layout.jsx`
4. Add all user-facing strings to `frontend/src/i18n/en.js` and `frontend/src/i18n/da.js`

## Translations
- Every visible string must use `t("keyName")`
- Add each key to both en.js and da.js with real text; the other languages fall back to English
- Payment methods map: cash, card, mobilepay, dankort, bank_transfer, mixed
