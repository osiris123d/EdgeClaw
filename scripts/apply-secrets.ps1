<#
.SYNOPSIS
    Apply all secrets from .dev.vars to the deployed Cloudflare Worker.

.DESCRIPTION
    Reads key=value pairs from .dev.vars and pipes each value to
    `wrangler secret put <KEY>` so secrets are stored encrypted in
    Cloudflare's backend.

    Secrets set this way persist across every future `npm run deploy` — you
    only need to run this script again when a secret value actually changes.

    Piping the value via stdin keeps it out of shell history and process args.

.EXAMPLE
    npm run secrets
    # or directly:
    pwsh -File scripts/apply-secrets.ps1
#>

$ErrorActionPreference = "Stop"

$devVarsPath = Join-Path $PSScriptRoot ".." ".dev.vars"
$devVarsPath = [System.IO.Path]::GetFullPath($devVarsPath)

if (-not (Test-Path $devVarsPath)) {
    Write-Error @"
.dev.vars not found at: $devVarsPath

Copy the example file and fill in your real values:
    cp .dev.vars.example .dev.vars
"@
    exit 1
}

$lines = Get-Content $devVarsPath
$applied = 0
$skipped = 0

foreach ($raw in $lines) {
    $line = $raw.Trim()

    # Skip blank lines and comments
    if ($line -eq "" -or $line.StartsWith("#")) {
        continue
    }

    $idx = $line.IndexOf("=")
    if ($idx -le 0) {
        Write-Warning "Skipping malformed line (no '='): $line"
        $skipped++
        continue
    }

    $key   = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()

    # Strip surrounding quotes
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    # Skip empty values — don't overwrite a real secret with a blank
    if ($value -eq "") {
        Write-Host "  SKIP  $key  (empty value — fill in .dev.vars first)"
        $skipped++
        continue
    }

    Write-Host "  SET   $key"
    # Pipe the value on stdin — keeps it out of shell history and process args
    $value | wrangler secret put $key
    if ($LASTEXITCODE -ne 0) {
        # Error 10053: name already used as a plain var in wrangler.jsonc/toml.
        # These should stay in wrangler.jsonc, not be set as secrets.
        Write-Warning "  SKIP  $key — already defined as a plain var in wrangler config (cannot also be a secret). Remove it from .dev.vars."
        $skipped++
        continue
    }
    $applied++
}

Write-Host ""
Write-Host "Done. Applied: $applied  Skipped: $skipped"
Write-Host "These secrets will be available in every future 'npm run deploy' automatically."
