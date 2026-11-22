$ErrorActionPreference = 'SilentlyContinue'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $appDir 'logs'

foreach ($name in @('web', 'llm', 'embed')) {
    $pidFile = Join-Path $logDir "$name.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $rawPid = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
        if ($rawPid -match '^\d+$') {
            $proc = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
            if ($proc) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Output "Stopped $name (PID $($proc.Id))"
            }
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}
