@echo off
setlocal

echo Running bonsAI checks...
call npm test
if errorlevel 1 (
  echo.
  echo [FAIL] Syntax checks failed.
  exit /b 1
)

echo.
echo [PASS] Syntax checks passed.
echo.
echo Manual browser checks:
echo 1. Refresh and confirm the selected model is preserved.
echo 2. Press Enter in the composer to send. Press Shift+Enter to insert a new line.
echo 3. Attach a PDF with special characters in the filename and confirm it renders as plain text.
echo 4. Rename and delete threads to verify the inline editor and modal flow.
exit /b 0
