# اطلاعیهٔ مجوزهای اجزای ثالث

دلاربان پلاس با مجوز MIT منتشر می‌شود ([LICENCE.md](LICENCE.md))؛ این پروژه فورکی از [DollarBaan](https://github.com/MahdiGraph/DollarBaan) اثر Mahdi Talebi (MahdiGraph) است. اجزای زیر همراه برنامه توزیع می‌شوند و مجوز خودشان را دارند. این فایل برای رعایت شرط «همراه داشتن اعلان مجوز» است، نه یک قدردانی در رابط برنامه.

| جزء | مجوز | محل | توضیح |
|---|---|---|---|
| [Vazirmatn](https://github.com/rastikerdar/vazirmatn) | SIL Open Font License 1.1 | `public/assets/fonts/` (متن مجوز: [OFL.txt](public/assets/fonts/OFL.txt)) | فونت رابط کاربری؛ فونت آزاد است و نیازی به ذکر نام در برنامه ندارد. |
| [Chart.js](https://www.chartjs.org) 4 | MIT | `public/assets/vendor/chart.umd.min.js` | نمودارها؛ اعلان مجوز در ابتدای همان فایل است. |
| [Lucide](https://lucide.dev) | ISC | `public/assets/icons.svg` | آیکون‌ها؛ اعلان مجوز در ابتدای همان فایل است. |
| Express، Sequelize، sqlite3، mysql2، winston، cookie-parser، dotenv | MIT / BSD | `package.json` | فقط در نسخهٔ سرور و هنگام نصب `npm install` دریافت می‌شوند. |
| Electron | MIT | `desktop/package.json` | پوستهٔ برنامهٔ دسکتاپ. |
| Capacitor | MIT | `mobile/package.json` | پوستهٔ برنامهٔ اندروید. |

## منابع دادهٔ بازار

برنامه فایل‌ها و APIهای عمومی زیر را مستقیماً از دستگاه کاربر می‌خواند. هیچ دادهٔ کاربری به آن‌ها فرستاده نمی‌شود و هر کدام شرایط استفادهٔ خودشان را دارند:

- [ایران مارکت (Iran Market Data)](https://github.com/iran-market/iran-market.github.io) (MIT): قیمت ارز، طلا، سکه و رمزارز.
- سامانهٔ عمومی بورس تهران (TSETMC): قیمت سهام و صندوق‌ها.
- [نوسان (Navasan)](https://navasan.tech): منبع اختیاری قیمت در نسخهٔ سرور؛ نیازمند کلید API کاربر.
- Wallex، Binance و Frankfurter (نرخ‌های بانک مرکزی اروپا): فقط برای تکمیل قیمت روزهای قدیمی‌تر رمزارزها و ارزها هنگام ثبت تراکنش قدیمی.

قیمت‌ها صرفاً برای اطلاع‌رسانی است و توصیهٔ خرید یا فروش نیست.
