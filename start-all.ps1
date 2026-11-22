$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $appDir 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# Python executable: prefer local .venv created by setup.bat, fallback to system python
$venvPy = Join-Path $appDir '.venv\Scripts\python.exe'
$pythonExe = if (Test-Path -LiteralPath $venvPy) { $venvPy } else { 'python' }

# Local standalone llama.cpp runtime & models (downloaded by setup.bat)
$localLlama = Join-Path $appDir 'runtime\llama-server.exe'
$localLlmModel = Join-Path $appDir 'models\gemma4-12b\gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'
$localLlmMmproj = Join-Path $appDir 'models\gemma4-12b\mmproj-F16.gguf'
$localLlmMtp = Join-Path $appDir 'models\gemma4-12b\MTP\mtp-gemma-4-12B-it-Q4_0.gguf'
$localChatTemplate = Join-Path $appDir 'scripts\gemma4-concise.jinja'
$localEmbedModel = Join-Path $appDir 'models\embeddinggemma-2\embeddinggemma-2-Q8_0.gguf'

# 1. Start EmbeddingGemma 2 on CPU (0 VRAM, port 8790) so Gemma 4 12B can use full GPU VRAM
if (-not (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)) {
    if ((Test-Path -LiteralPath $localLlama) -and (Test-Path -LiteralPath $localEmbedModel)) {
        Write-Output 'Starting EmbeddingGemma 2 (CPU mode) on port 8790...'
        $embedArgs = @(
            '-m', "`"$localEmbedModel`"",
            '--embeddings',
            '--host', '127.0.0.1',
            '--port', '8790',
            '-c', '8192', '-b', '8192', '-ub', '8192',
            '-ngl', '0'
        )
        $prevCuda = $env:CUDA_VISIBLE_DEVICES
        $env:CUDA_VISIBLE_DEVICES = '-1'
        try {
            $ep = Start-Process -FilePath $localLlama -ArgumentList $embedArgs `
                -WorkingDirectory (Split-Path -Parent $localLlama) -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $logDir 'embed.out') `
                -RedirectStandardError (Join-Path $logDir 'embed.err') -PassThru
        } finally {
            if ($null -eq $prevCuda) {
                Remove-Item Env:CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue
            } else {
                $env:CUDA_VISIBLE_DEVICES = $prevCuda
            }
        }
        Set-Content -Path (Join-Path $logDir 'embed.pid') -Value $ep.Id

        $embedOk = $false
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            if ($ep.HasExited) { throw "EmbeddingGemma 2 exited early. Check $logDir\embed.err" }
            try {
                if ((Invoke-RestMethod 'http://127.0.0.1:8790/health' -TimeoutSec 2).status -eq 'ok') {
                    $embedOk = $true
                    break
                }
            } catch {}
            Start-Sleep -Milliseconds 400
        }
        if (-not $embedOk) {
            throw "EmbeddingGemma 2 did not become ready in time. Check $logDir\embed.err"
        }
        Write-Output "EmbeddingGemma 2 ready: http://127.0.0.1:8790/v1/embeddings (PID $($ep.Id))"
    } else {
        throw 'EmbeddingGemma 2 runtime/model not found. Please run setup.bat first.'
    }
} else {
    Write-Output 'EmbeddingGemma 2 already listening on port 8790.'
}

# 2. Start Gemma 4 12B Unified on GPU (port 8770, 4 parallel slots)
if (-not (Get-NetTCPConnection -LocalPort 8770 -State Listen -ErrorAction SilentlyContinue)) {
    if ((Test-Path -LiteralPath $localLlama) -and (Test-Path -LiteralPath $localLlmModel)) {
        $devOut = ''
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $devOut = (& $localLlama --list-devices 2>&1) -join "`n"
        } catch {
            $devOut = ''
        } finally {
            $ErrorActionPreference = $prevEap
        }
        if ($devOut -notmatch '(?m)^\s*(CUDA|Vulkan|ROCm)[0-9]+:') {
            Write-Output ''
            Write-Output '[WARNING] GPU が見つかりません。Gemma 4 は CPU で動くため、とても遅くなります。'
            Write-Output 'NVIDIA ドライバが入っているか確認し、だめなら setup.bat をやり直してください。'
            Write-Output ''
        }

        Write-Output 'Starting Gemma 4 12B QAT + MTP (GPU mode) on port 8770...'
        $llmArgs = @(
            '-m', "`"$localLlmModel`"",
            '--alias', 'gemma4-12b',
            '--host', '127.0.0.1',
            '--port', '8770',
            '-ngl', '99',
            '-fa', 'on',
            '-c', '131072',
            '-np', '4',
            '--jinja',
            '--reasoning', 'auto',
            '--reasoning-format', 'deepseek',
            '--reasoning-budget', '150',
            '--reasoning-budget-message', '"ここまでにして結論を書く。"',
            '--reasoning-effort', 'medium'
        )
        if (Test-Path -LiteralPath $localChatTemplate) {
            $llmArgs += @('--chat-template-file', "`"$localChatTemplate`"")
        }
        if (Test-Path -LiteralPath $localLlmMmproj) {
            $llmArgs += @('--mmproj', "`"$localLlmMmproj`"")
        }
        if (Test-Path -LiteralPath $localLlmMtp) {
            $llmArgs += @(
                '--model-draft', "`"$localLlmMtp`"",
                '-ngld', '99',
                '--spec-type', 'draft-mtp,ngram-simple',
                '--spec-draft-n-max', '4'
            )
        }
        $lp = Start-Process -FilePath $localLlama -ArgumentList $llmArgs `
            -WorkingDirectory (Split-Path -Parent $localLlama) -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir 'llm.out') `
            -RedirectStandardError (Join-Path $logDir 'llm.err') -PassThru
        Set-Content -Path (Join-Path $logDir 'llm.pid') -Value $lp.Id

        $llmOk = $false
        $deadline = (Get-Date).AddSeconds(300)
        while ((Get-Date) -lt $deadline) {
            if ($lp.HasExited) { throw "Gemma 4 12B exited early. Check $logDir\llm.err" }
            try {
                if ((Invoke-RestMethod 'http://127.0.0.1:8770/health' -TimeoutSec 2).status -eq 'ok') {
                    $llmOk = $true
                    break
                }
            } catch {}
            Start-Sleep -Milliseconds 500
        }
        if (-not $llmOk) {
            throw "Gemma 4 12B did not become ready in time. Check $logDir\llm.err"
        }
        Write-Output "Gemma 4 12B ready: http://127.0.0.1:8770/v1 (PID $($lp.Id))"
    } else {
        throw 'Gemma 4 12B runtime/model not found. Please run setup.bat first.'
    }
} else {
    Write-Output 'Gemma 4 12B server already listening on port 8770.'
}

# 3. Start Web UI (FastAPI) on port 8000 (HTTPS + LAN / Wi-Fi 共有対応: 0.0.0.0)
$certFile = Join-Path $appDir 'certs\cert.pem'
$keyFile = Join-Path $appDir 'certs\key.pem'
if (-not (Test-Path -LiteralPath $certFile) -or -not (Test-Path -LiteralPath $keyFile)) {
    & $pythonExe (Join-Path $appDir 'gen_cert.py')
}

if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Output 'Starting Gakumon Web UI on https://0.0.0.0:8000 ...'
    $uvicornArgs = @(
        '-m', 'uvicorn', 'app:app',
        '--host', '0.0.0.0', '--port', '8000',
        '--ssl-certfile', "`"$certFile`"",
        '--ssl-keyfile', "`"$keyFile`""
    )
    $web = Start-Process -FilePath $pythonExe -ArgumentList $uvicornArgs `
        -WorkingDirectory $appDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir 'web.out') `
        -RedirectStandardError (Join-Path $logDir 'web.err') -PassThru
    Set-Content -Path (Join-Path $logDir 'web.pid') -Value $web.Id

    $webOk = $false
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if ($web.HasExited) { throw "Web UI exited early. Check $logDir\web.err" }
        if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
            $webOk = $true
            break
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not $webOk) {
        throw "Web UI did not become ready in time. Check $logDir\web.err"
    }
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.InterfaceAlias -match 'Wi-Fi|Ethernet|イーサネット' -and
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*'
        } |
        Select-Object -First 1 -ExpandProperty IPAddress)
    Write-Output "Web UI ready (HTTPS): https://127.0.0.1:8000 (PID $($web.Id))"
    if ($lanIp) {
        Write-Output "LAN URL（同じネットワーク内のスマホから）: https://${lanIp}:8000"
    }
} else {
    Write-Output 'Web UI already listening on port 8000'
}
