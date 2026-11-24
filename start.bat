@echo off
REM مشغّل سريع لتطبيق "مدّ" على ويندوز
cd /d "%~dp0app"
if not exist node_modules (
  echo ^> تثبيت الحزم...
  call npm install
)
echo ^> بناء التطبيق...
call npm run build
echo ^> التشغيل على http://localhost:4173
call npm run preview
