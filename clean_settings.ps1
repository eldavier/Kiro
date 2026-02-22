$p = "$env:APPDATA\Kiro Dev\User\settings.json"
$j = Get-Content $p -Raw | ConvertFrom-Json

# Remove copilot/claudeCodeChat refs from applyToAllProfiles
$old = $j.'workbench.settings.applyToAllProfiles'
$new = @($old | Where-Object { $_ -notmatch '^github\.copilot' -and $_ -notmatch '^claudeCodeChat' })
$j.'workbench.settings.applyToAllProfiles' = $new

# Clear invalid defaultFormatter
$j.'notebook.defaultFormatter' = $null

# Clear invalid inlineChat.defaultModel referencing copilot
$j.'inlineChat.defaultModel' = $null

# Write back
$j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding UTF8
Write-Host "Done - cleaned settings"
