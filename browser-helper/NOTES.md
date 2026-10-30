# API and Origin compatibility
Chrome cookies and runtime permissions APIs confirmed from:
https://developer.chrome.com/docs/extensions/reference/api/cookies
https://developer.chrome.com/docs/extensions/reference/api/permissions
Chromium popup POST fetch tests expect the extension Origin:
https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/extensions/fetch_apitest.cc
GET fetch may omit Origin; our helper uses POST. Receiver deliberately rejects missing/null/web Origins; it never grants wildcard CORS. Actual installed Edge/Chrome behavior remains for parent synthetic browser E2E verification. No real user cookies were accessed.
Endpoint: POST /qchat-connect, Content-Type application/json, X-QChat-Token from fragment, JSON {cookies:[{name,value,domain,path,expirationDate?}]}. expirationDate is Unix seconds; absent means session lifetime. Only unpartitioned root ChatGPT session cookie families are copied.
