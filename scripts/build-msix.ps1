param(
  [string]$Version = "1.0.0.0",
  [string]$Architecture = "x64",
  [string]$PfxPath = "",
  [string]$PfxPassword = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot "src-tauri/target/release"
$bundleDir = Join-Path $releaseDir "bundle/msix"
$stageDir = Join-Path $bundleDir "staging"
$appExe = Join-Path $releaseDir "EasyMarkdown.exe"

if (-not (Test-Path $appExe)) {
  Write-Host "Release binary not found. Building app first..."
  Push-Location $projectRoot
  try {
    npx tauri build -b msi
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path $appExe)) {
  throw "EasyMarkdown.exe was not produced."
}

if (Test-Path $stageDir) {
  Remove-Item $stageDir -Recurse -Force
}

New-Item -ItemType Directory -Path $stageDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "icons") | Out-Null

Copy-Item $appExe -Destination (Join-Path $stageDir "EasyMarkdown.exe") -Force

$iconSourceDir = Join-Path $projectRoot "src-tauri/icons"
$iconFiles = @(
  "Square44x44Logo.png",
  "Square150x150Logo.png",
  "Square310x310Logo.png",
  "StoreLogo.png"
)

foreach ($icon in $iconFiles) {
  $source = Join-Path $iconSourceDir $icon
  if (-not (Test-Path $source)) {
    throw "Required icon not found: $source"
  }
  Copy-Item $source -Destination (Join-Path $stageDir "icons/$icon") -Force
}

$manifestPath = Join-Path $stageDir "AppxManifest.xml"

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap desktop rescap">

  <Identity
    Name="CarlosSarria.EasyMarkdown"
    Publisher="CN=A54C6271-1F1D-4473-96D5-B5AE89D0EB7D"
    Version="$Version"
    ProcessorArchitecture="$Architecture" />

  <Properties>
    <DisplayName>EasyMarkdown</DisplayName>
    <PublisherDisplayName>Carlos Sarria</PublisherDisplayName>
    <Logo>icons/StoreLogo.png</Logo>
    <Description>A lightweight, cross-platform Markdown viewer</Description>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Applications>
    <Application Id="App" Executable="EasyMarkdown.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="EasyMarkdown"
        Description="A lightweight, cross-platform Markdown viewer"
        BackgroundColor="transparent"
        Square150x150Logo="icons/Square150x150Logo.png"
        Square44x44Logo="icons/Square44x44Logo.png">
        <uap:DefaultTile
          Wide310x150Logo="icons/Square310x310Logo.png"
          Square310x310Logo="icons/Square310x310Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap:FileTypeAssociation Name="markdown">
            <uap:SupportedFileTypes>
              <uap:FileType>.md</uap:FileType>
              <uap:FileType>.markdown</uap:FileType>
              <uap:FileType>.mkd</uap:FileType>
              <uap:FileType>.mdown</uap:FileType>
            </uap:SupportedFileTypes>
          </uap:FileTypeAssociation>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>

</Package>
"@

Set-Content -Path $manifestPath -Value $manifest -Encoding utf8

$makeAppx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$Architecture\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $makeAppx) {
  throw "makeappx.exe not found. Install Windows SDK."
}

$msixPath = Join-Path $bundleDir "EasyMarkdown_${Version}_${Architecture}.msix"
if (Test-Path $msixPath) {
  Remove-Item $msixPath -Force
}

& $makeAppx pack /d $stageDir /p $msixPath /o | Write-Host

if (-not (Test-Path $msixPath)) {
  throw "MSIX package was not created."
}

if ($PfxPath) {
  $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$Architecture\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName

  if (-not $signTool) {
    throw "signtool.exe not found in Windows SDK."
  }

  if (-not (Test-Path $PfxPath)) {
    throw "PFX certificate not found: $PfxPath"
  }

  $signArgs = @("sign", "/fd", "SHA256", "/f", $PfxPath)
  if ($PfxPassword) {
    $signArgs += @("/p", $PfxPassword)
  }
  $signArgs += $msixPath

  & $signTool @signArgs | Write-Host
}

Write-Host "MSIX ready: $msixPath"
