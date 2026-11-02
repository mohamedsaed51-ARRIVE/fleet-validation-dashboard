# لوحة متابعة Fleet Validation (ARRIVE)

## الملفات
- `Code.gs`  — Google Apps Script (يُلصق داخل الشيت). يجمّع البيانات ويكتبها JSON في ورقة `DASH_SNAPSHOT`.
- `index.html` — الداشبورد (ملف واحد، نفس منهج داشبورد الشكاوي: HTML + Chart.js + توكنز ARRIVE).
- `tests/code.test.js` — اختبار منطق التجميع: `node tests/code.test.js`

## التشغيل
1. افتح الشيت: Extensions ▸ Apps Script ▸ الصق `Code.gs` ▸ شغّل `setupAll()` ووافق على الصلاحيات.
2. Deploy ▸ New deployment ▸ Web app (Execute as: Me — Who has access: Anyone) ▸ انسخ رابط `/exec`.
3. افتح `index.html` ▸ «الإعدادات» ▸ الصق الرابط (أو ضعه في `API_URL` أعلى السكربت).
4. للنشر: ارفع `index.html` على Vercel/GitHub Pages كما في داشبورد الشكاوي.

التحديث التلقائي: Trigger كل ساعة على `buildSnapshot()` (يتم تركيبه تلقائيًا بـ `setupAll()`). الأوراق الخام لا تُعدّل؛ الورقة المضافة الوحيدة `DASH_SNAPSHOT`.
