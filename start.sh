#!/usr/bin/env bash
# مشغّل سريع لتطبيق "مدّ" — يثبّت الحزم ثم يخدم نسخة الإنتاج.
set -e
cd "$(dirname "$0")/app"
if [ ! -d node_modules ]; then
  echo "› تثبيت الحزم…"
  npm install
fi
echo "› بناء التطبيق…"
npm run build
echo "› التشغيل على http://localhost:4173  (اضغط Ctrl+C للإيقاف)"
npm run preview
