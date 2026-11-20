# همگام‌سازی با پروژه اصلی (DollarBaan)

دلاربان پلاس یک فورک از [MahdiGraph/DollarBaan](https://github.com/MahdiGraph/DollarBaan) است. این فایل روش گرفتن تغییرات پروژه اصلی را توضیح می‌دهد. همگام‌سازی **اجباری نیست**: پلاس مستقل رشد می‌کند و هر تغییر مفید پروژه اصلی را هر وقت خواستید می‌توانید بردارید.

**آخرین نقطهٔ پایه:** DollarBaan `2.1.0` (commit `7823676`).

## ادغام یک نسخهٔ جدید

```bash
git remote add upstream https://github.com/MahdiGraph/DollarBaan.git   # فقط بار اول
git fetch upstream --tags
git checkout -b upstream-sync/manual
git merge upstream/main
# تعارض‌ها را حل کنید، سپس:
npm test
```

پس از ادغام موفق، `npm test` و برنامه را یک بار اجرا کنید و Pull Request بزنید. اگر گیت در حل تعارض‌های تکراری کمک خواست: `git config rerere.enabled true`.

یک workflow ماهانه (`.github/workflows/upstream-sync.yml`) هم هست: اگر پروژه اصلی تغییر کرده باشد، ادغام را امتحان می‌کند و یا یک Pull Request آماده می‌سازد یا یک Issue با فهرست فایل‌های متعارض باز می‌کند. هیچ چیزی خودکار در `main` ادغام نمی‌شود. اگر نمی‌خواهید، فایل آن را حذف کنید.

## کجا ممکن است تعارض پیش بیاید؟

ویژگی‌های پلاس تا جای ممکن در **فایل‌های تازه** نوشته شده‌اند، پس بیشتر تغییرات پروژه اصلی بدون تعارض ادغام می‌شوند:

| فایل‌های تازه (بدون تعارض) | کاربرد |
|---|---|
| `public/assets/js/shared/plus/` | پول نقد، برداشت سود، سود و زیان، سهام، محل نگهداری، پشتیبان، تاریخچهٔ قیمت |
| `public/assets/js/shared/providers/tsetmc.js` | فهرست و قیمت همهٔ بورس تهران (دیدبان بازار)، تاریخچه و جستجو |
| `public/assets/js/plus/`، `pages/cash.js`، `pages/pnl.js` | رابط پروفایل‌ها، قفل، پول نقد و سود و زیان |
| `public/assets/js/local/profiles.js`، `server/services/runtimes.js`، `server/services/plus.js` | پروفایل‌ها |
| `public/assets/css/plus.css` | استایل بخش‌های تازه |

فایل‌هایی که از پروژه اصلی تغییر کرده‌اند و در صورت تغییر آن‌ها در پروژه اصلی باید دستی بررسی شوند:

| فایل | تغییر پلاس |
|---|---|
| `shared/ledger.js` | برداشت سود (بدون کاستن از بهای تمام‌شده) و کنار گذاشتن پول نقد از سرمایه |
| `shared/core/market.js` | چند قلاب کوچک برای افزونه‌ها (`extensions`)، فهرست‌کردن دارایی‌های غیربازاری (سهام بورس با پرچم `listed` خودشان) و `priceAt`: قیمت فقط همان روز یا روز قبل از آن (هرگز روز بعد) و گزینهٔ `refresh` |
| `shared/catalog.js` | دسته‌های «سهام» و «پول نقد» |
| `local/idb-store.js`، `server/db.js`، `server/store.js` | فیلدهای تازهٔ تراکنش، جدول `docs`، نوشتن دسته‌ای (atomic)، پایگاه‌داده جدا برای هر پروفایل |
| `local/backend.js`، `server/routes/api.js`، `server/index.js` | چندپروفایلی و مسیرهای تازهٔ API |
| `pages/*.js`، `ui/transaction-form.js`، `ui/asset-picker.js`، `main.js`، `state.js`، `api.js`، `index.html` | محل نگهداری، پول نقد، آکاردئون دارایی‌ها، تب پروفایل‌ها، منوها |
| `package.json`، `desktop/*`، `mobile/*`، `.github/*` | نام، شناسهٔ برنامه، نام فایل‌های خروجی |

هسته‌ای که پلاس از آن ارث می‌برد (`PortfolioCore`) دست‌نخورده است و `PlusPortfolioCore` از آن ارث می‌برد؛ پس اصلاح‌های آیندهٔ آن خودکار به پلاس می‌رسد.

## سازگاری فایل پشتیبان

فایل پشتیبانی که خود دلاربان می‌سازد (`app: "DollarBaan"`) در هر پروفایل پلاس بازیابی می‌شود. تشخیص نوع فایل بر پایهٔ ساختار آن است، نه شمارهٔ نسخه (`backupKind` در `shared/plus/backup.js`)، و فیلدهای ناشناخته نادیده گرفته می‌شوند. اگر پروژه اصلی روزی قالب پشتیبان را عوض کند، فقط همان تابع را هماهنگ کنید؛ آزمون‌های `test/plus.test.js` و `test/profiles-api.test.js` این مسیر را پوشش می‌دهند.

## نسخه‌بندی

پلاس نسخه‌شمار مستقلی دارد (`1.x`). پس از هر ادغام، تغییرات را در `CHANGELOG.md` بنویسید و برای انتشار، نسخه را در `package.json` بالا ببرید و `npm run version:sync` را اجرا کنید.
