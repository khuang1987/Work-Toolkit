# OCR an image using Windows.Media.Ocr, output lines with bounding boxes
param([string]$ImagePath = (Join-Path $PSScriptRoot 'teams_shot.png'), [string]$OutFile = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$fullPath = [System.IO.Path]::GetFullPath($ImagePath)
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = [Windows.Globalization.Language]::new('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { Write-Output 'NO_OCR_ENGINE'; exit 1 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add(("SIZE {0} {1}" -f $bitmap.PixelWidth, $bitmap.PixelHeight))
foreach ($line in $result.Lines) {
  if ($line.Words.Count -eq 0) { continue }
  $minx = [double]::MaxValue; $miny = [double]::MaxValue; $maxx = -1.0; $maxy = -1.0
  foreach ($wd in $line.Words) {
    $x = [double]$wd.BoundingRect.X; $y = [double]$wd.BoundingRect.Y
    $w = [double]$wd.BoundingRect.Width; $h = [double]$wd.BoundingRect.Height
    if ($x -lt $minx) { $minx = $x }
    if ($y -lt $miny) { $miny = $y }
    if (($x + $w) -gt $maxx) { $maxx = $x + $w }
    if (($y + $h) -gt $maxy) { $maxy = $y + $h }
  }
  $lines.Add(("TEXT {0} {1} {2} {3} {4}" -f [int][math]::Round($minx), [int][math]::Round($miny), [int][math]::Round($maxx), [int][math]::Round($maxy), $line.Text))
}
if ($OutFile) {
  [System.IO.File]::WriteAllLines($OutFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
} else {
  $lines | ForEach-Object { Write-Output $_ }
}
