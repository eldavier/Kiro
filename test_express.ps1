$k = "AQ.Ab8RN6Jkwmtp3eOMaPihPf9XI_Vqt3NbdRCTHtnIuRe9tl3u1w"
$base = "https://aiplatform.googleapis.com/v1/publishers/google/models"

# Test 1: generateContent
Write-Host "=== TEST 1: generateContent ==="
$u1 = "$base/gemini-2.0-flash:generateContent?key=$k"
$b = '{"contents":[{"role":"user","parts":[{"text":"Say hi in one word"}]}]}'
try {
    $r = Invoke-RestMethod -Uri $u1 -Method POST -ContentType "application/json" -Body $b
    Write-Host "OK: $($r.candidates[0].content.parts[0].text)"
} catch {
    Write-Host "FAIL: $($_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}

# Test 2: streamGenerateContent
Write-Host "`n=== TEST 2: streamGenerateContent ==="
$u2 = "$base/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$k"
try {
    $r2 = Invoke-WebRequest -Uri $u2 -Method POST -ContentType "application/json" -Body $b -UseBasicParsing
    Write-Host "STATUS: $($r2.StatusCode)"
    Write-Host "FIRST 300 CHARS:"
    Write-Host $r2.Content.Substring(0, [Math]::Min(300, $r2.Content.Length))
} catch {
    Write-Host "FAIL: $($_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}

# Test 3: gemini-2.5-flash
Write-Host "`n=== TEST 3: gemini-2.5-flash ==="
$u3 = "$base/gemini-2.5-flash:generateContent?key=$k"
try {
    $r3 = Invoke-RestMethod -Uri $u3 -Method POST -ContentType "application/json" -Body $b
    Write-Host "OK: $($r3.candidates[0].content.parts[0].text)"
} catch {
    Write-Host "FAIL: $($_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}

# Test 4: gemini-2.5-pro
Write-Host "`n=== TEST 4: gemini-2.5-pro ==="
$u4 = "$base/gemini-2.5-pro:generateContent?key=$k"
try {
    $r4 = Invoke-RestMethod -Uri $u4 -Method POST -ContentType "application/json" -Body $b
    Write-Host "OK: $($r4.candidates[0].content.parts[0].text)"
} catch {
    Write-Host "FAIL: $($_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}

Write-Host "`n=== ALL TESTS DONE ==="
