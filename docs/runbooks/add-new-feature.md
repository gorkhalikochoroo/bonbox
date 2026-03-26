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
4. Add all user-facing strings to translations in `frontend/src/hooks/useLanguage.jsx` (EN, DA, NP)

## Translations
- Every visible string must use `t("keyName")`
- Add key to all 3 languages in useLanguage.jsx
- Payment methods map: cash, card, mobilepay, dankort, bank_transfer, mixed
