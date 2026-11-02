$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    throw "C# compiler not found"
}

& $csc /nologo /codepage:65001 /target:winexe /platform:anycpu `
    "/win32icon:$root\launcher\app-icon.ico" `
    "/out:$root\ComfyInfinity.exe" `
    "/r:System.Windows.Forms.dll" `
    "/r:System.Drawing.dll" `
    "$root\launcher\launcher.cs"
if ($LASTEXITCODE -ne 0) {
    throw "launcher build failed"
}
Write-Output (Join-Path $root "ComfyInfinity.exe")
