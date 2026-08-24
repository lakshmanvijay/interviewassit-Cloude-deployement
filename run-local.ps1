# Launches the app pointed at a LOCAL backend instead of Railway.
# Requires your backend running at localhost:8080 (and, if you use one, a
# local web login page at localhost:5173) — start those first.
#
# Usage:  .\run-local.ps1

$env:INTERVIEWASSIST_WEB_LOGIN_URL = "https://vijayamai.com/login"
$env:INTERVIEWASSIST_LOGIN_API_URL = "https://interview-backend-production-c8b5.up.railway.app/api/auth/logi"
$env:OPEN_DEVTOOLS = "1"
$env:DEBUG_CONSOLE = "1"

npm start
