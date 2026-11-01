# 按 .nvmrc 把 Node 下载到 .toolchain/runtime/node/（Windows），核对官方 SHA256
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ver = (Get-Content (Join-Path $Root '.nvmrc') -Raw).Trim().TrimStart('v')
$runtime = Join-Path $Root '.toolchain\runtime'
$dir = Join-Path $runtime 'node'
$exe = Join-Path $dir 'node.exe'

if (Test-Path $exe) {
    if ((& $exe -v) -eq "v$ver") { exit 0 }
    Write-Host "Node 版本与 .nvmrc 不一致，重新下载 v$ver"
    Remove-Item -Recurse -Force $dir
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { 'x86' } }
$name = "node-v$ver-win-$arch"
$base = "https://nodejs.org/dist/v$ver"
$tmp = Join-Path $Root '.toolchain\tmp'
New-Item -ItemType Directory -Force $tmp, $runtime | Out-Null
$zip = Join-Path $tmp "$name.zip"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "下载 Node v$ver（$arch）..."
Invoke-WebRequest "$base/$name.zip" -OutFile $zip -UseBasicParsing
$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape("$name.zip") + '\s*$') } | Select-Object -First 1
if (-not $line) { throw "SHASUMS256.txt 中找不到 $name.zip" }
$expected = ($line.Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { Remove-Item $zip; throw "SHA256 校验失败：期望 $expected，实际 $actual" }

tar -xf $zip -C $runtime
if ($LASTEXITCODE -ne 0) { throw "解压失败" }
Rename-Item (Join-Path $runtime $name) 'node'
Remove-Item $zip
Write-Host "Node v$ver 已就绪：$dir"
