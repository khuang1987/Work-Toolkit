# 升版后把最新的安装包和使用说明复制到共享的 OneDrive 目录，并删除该目录里的旧版本（只保留新版）。
# 用法：.\sync-release.ps1
$ErrorActionPreference = 'Stop'
$releases = Join-Path $PSScriptRoot 'releases'
$dest = 'C:\Users\huangk14\OneDrive - Medtronic PLC\CZ Production - 文档\Project\fabriq'

$zip = Get-ChildItem $releases -Filter 'MedtronicWorkAssistant-v*.zip' |
  Sort-Object { [version]($_.BaseName -replace '^MedtronicWorkAssistant-v', '') } -Descending | Select-Object -First 1
if (-not $zip) { throw "未在 $releases 找到安装包" }
$version = $zip.BaseName -replace '^MedtronicWorkAssistant-v', ''
$pdf = Join-Path $releases "Medtronic-Work-Assistant-使用说明-v$version.pdf"
if (-not (Test-Path $pdf)) { throw "缺少使用说明：$pdf" }
if (-not (Test-Path $dest)) { throw "目标目录不存在：$dest" }

Copy-Item $zip.FullName $dest -Force
Copy-Item $pdf $dest -Force

# 只保留新版：删除目录里其他版本的安装包和说明
Get-ChildItem $dest -File | Where-Object {
  ($_.Name -like 'MedtronicWorkAssistant-v*.zip' -and $_.Name -ne $zip.Name) -or
  ($_.Name -like 'Medtronic-Work-Assistant-使用说明-v*.pdf' -and $_.Name -ne (Split-Path $pdf -Leaf))
} | ForEach-Object { Remove-Item $_.FullName -Force; "已删除旧版：$($_.Name)" }

"已同步 v$version 到 $dest"
