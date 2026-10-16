$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try { node scripts/playground.mjs start } finally { Pop-Location }
