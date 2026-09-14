$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$extractor = Join-Path $PSScriptRoot 'extract-yue-runtime.ps1'
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + '\'
$testName = 'aiplay-runtime-extract-test-' + [Guid]::NewGuid().ToString('N')
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempPrefix $testName))
if (-not $testRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test directory' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:caseNumber = 0
$script:passed = 0

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function New-Spec([string]$Name, [string]$Content) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Content)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
  return @{ name = $Name; bytes = $bytes.Length; sha256 = $digest }
}

function New-Case([object[]]$Entries, [object[]]$Files) {
  $script:caseNumber++
  $folder = Join-Path $testRoot ('case-' + $script:caseNumber)
  New-Item -ItemType Directory -Path $folder | Out-Null
  $archive = Join-Path $folder 'fixture.zip'
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($item in $Entries) {
      $entry = $zip.CreateEntry($item.Name, [IO.Compression.CompressionLevel]::Optimal)
      if ($item.ContainsKey('Attributes')) { $entry.ExternalAttributes = $item.Attributes }
      $stream = $entry.Open()
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item.Content)
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
  $manifest = Join-Path $folder 'manifest.json'
  [IO.File]::WriteAllText($manifest, (ConvertTo-Json -InputObject @($Files) -Depth 4), [Text.UTF8Encoding]::new($false))
  return @{ Folder = $folder; Archive = $archive; Manifest = $manifest; Destination = (Join-Path $folder 'output') }
}

function Invoke-Fixture($Case) {
  & $extractor -Archive $Case.Archive -Destination $Case.Destination -Manifest $Case.Manifest
}

function Assert-Rejected($Case, [string]$Pattern) {
  $caught = $null
  try { Invoke-Fixture $Case } catch { $caught = $_ }
  Assert-Test ($null -ne $caught) 'Unsafe or invalid ZIP unexpectedly succeeded'
  Assert-Test ($caught.Exception.Message -match $Pattern) ('Unexpected error: ' + $caught.Exception.Message)
}

function Pass([string]$Name) {
  $script:passed++
  Write-Output ('PASS ' + $Name)
}

try {
  $case = New-Case @(@{ Name = 'licenses\'; Content = '' }, @{ Name = 'licenses\notice.txt'; Content = 'notice' }, @{ Name = 'empty.txt'; Content = '' }) @((New-Spec 'licenses/notice.txt' 'notice'), (New-Spec 'empty.txt' ''))
  Invoke-Fixture $case
  Assert-Test ([IO.File]::ReadAllText((Join-Path $case.Destination 'licenses/notice.txt')) -eq 'notice') 'Valid nested file was not extracted'
  Assert-Test ((Get-Item -LiteralPath (Join-Path $case.Destination 'empty.txt')).Length -eq 0) 'Empty file was not extracted'
  Pass 'valid nested ZIP, normalized backslashes, harmless directory entry and empty file'

  $nextArchive = New-Case @(@{ Name = 'licenses/'; Content = '' }, @{ Name = 'licenses/second.txt'; Content = 'second' }) @((New-Spec 'licenses/second.txt' 'second'))
  $nextArchive.Destination = $case.Destination
  Invoke-Fixture $nextArchive
  Assert-Test ([IO.File]::ReadAllText((Join-Path $case.Destination 'licenses/notice.txt')) -eq 'notice') 'The second archive changed the first archive output'
  Assert-Test ([IO.File]::ReadAllText((Join-Path $case.Destination 'licenses/second.txt')) -eq 'second') 'A second archive could not share staging directories'
  Pass 'disjoint runtime archives can share existing staging directories'

  foreach ($name in @('../escape.txt', '..\escape.txt', '/escape.txt', 'C:\escape.txt', '..\..\outside\created\', '../outside/', 'valid/../escape.txt')) {
    $case = New-Case @(@{ Name = $name; Content = '' }) @((New-Spec 'valid.txt' ''))
    Assert-Rejected $case 'Unsafe runtime path'
    Assert-Test (-not (Test-Path -LiteralPath $case.Destination)) 'Traversal created an output directory'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $testRoot 'outside'))) 'Traversal created an unrelated directory'
  }
  Pass 'file and directory traversal, absolute paths and backslash directory regression'

  foreach ($name in @('extra.txt', 'unused/')) {
    $case = New-Case @(@{ Name = 'valid.txt'; Content = 'valid' }, @{ Name = $name; Content = '' }) @((New-Spec 'valid.txt' 'valid'))
    Assert-Rejected $case 'Unexpected runtime'
    Assert-Test (-not (Test-Path -LiteralPath $case.Destination)) 'Unexpected entry created output before validation completed'
  }
  Pass 'unexpected files and directories fail before extraction'

  foreach ($attributes in @(-1610612736, 1024, 268435456)) {
    $case = New-Case @(@{ Name = 'valid.txt'; Content = 'valid'; Attributes = $attributes }) @((New-Spec 'valid.txt' 'valid'))
    Assert-Rejected $case 'Symbolic links, reparse points and special files'
  }
  Pass 'ZIP symlink, Windows reparse and FIFO attributes'

  foreach ($names in @(@('valid.txt','valid.txt'), @('valid.txt','VALID.TXT'), @('folder/valid.txt','folder\valid.txt'))) {
    $case = New-Case @(@{ Name = $names[0]; Content = 'valid' }, @{ Name = $names[1]; Content = 'valid' }) @((New-Spec $names[0] 'valid'))
    Assert-Rejected $case 'Duplicate runtime archive path'
    Assert-Test (-not (Test-Path -LiteralPath $case.Destination)) 'Duplicate entry created output'
  }
  Pass 'exact, case-insensitive and separator-alias duplicate ZIP paths'

  $case = New-Case @(@{ Name = 'valid.txt'; Content = 'valid' }) @((New-Spec 'valid.txt' 'valid'), (New-Spec 'VALID.TXT' 'valid'))
  Assert-Rejected $case 'Duplicate runtime manifest path'
  $case = New-Case @(@{ Name = 'folder'; Content = 'valid' }) @((New-Spec 'folder' 'valid'), (New-Spec 'folder/valid.txt' 'valid'))
  Assert-Rejected $case 'conflicts with a directory'
  Pass 'duplicate manifest names and manifest file/directory conflicts'

  foreach ($name in @('aux.txt', 'COM1.exe', 'conout$.txt', 'NUL .txt', 'file.', 'file ', 'sub//file', 'a:stream', 'a/../b', 'file?.txt', 'NUL/child.txt')) {
    $case = New-Case @(@{ Name = 'valid.txt'; Content = 'valid' }) @((New-Spec $name 'valid'))
    Assert-Rejected $case 'Unsafe runtime path'
  }
  Pass 'Windows device names, ambiguous names, invalid characters and manifest traversal'

  foreach ($badMetadata in @(@{ bytes = -1; sha256 = ('a' * 64) }, @{ bytes = 1.5; sha256 = ('a' * 64) }, @{ bytes = '5'; sha256 = ('a' * 64) }, @{ bytes = 5; sha256 = 'bad-hash' })) {
    $badMetadata.name = 'valid.txt'
    $case = New-Case @(@{ Name = 'valid.txt'; Content = 'valid' }) @($badMetadata)
    Assert-Rejected $case 'Invalid runtime manifest file'
  }
  $case = New-Case @() @()
  Assert-Rejected $case 'manifest is empty'
  Pass 'invalid manifest byte counts, hashes and an empty file list'

  $case = New-Case @(@{ Name = 'valid.txt'; Content = 'wrong' }) @((New-Spec 'valid.txt' 'valid'))
  Assert-Rejected $case 'checksum mismatch'
  Pass 'same-length content corruption fails its SHA-256 check'

  $case = New-Case @(@{ Name = 'valid.txt'; Content = 'too long' }) @((New-Spec 'valid.txt' 'valid'))
  Assert-Rejected $case 'Runtime size mismatch'
  Assert-Test (-not (Test-Path -LiteralPath $case.Destination)) 'Declared size mismatch created output'
  $case = New-Case @() @((New-Spec 'missing.txt' 'valid'))
  Assert-Rejected $case 'missing files'
  Pass 'declared size mismatch and missing expected files'

  $case = New-Case @(@{ Name = 'bomb.txt'; Content = ('x' * 8192) }) @((New-Spec 'bomb.txt' 'xxxx'))
  $zipBytes = [IO.File]::ReadAllBytes($case.Archive)
  $changedHeaders = 0
  for ($offset = 0; $offset -le $zipBytes.Length - 28; $offset++) {
    $signature = [BitConverter]::ToUInt32($zipBytes, $offset)
    if ($signature -eq 0x04034b50 -or $signature -eq 0x02014b50) {
      $sizeOffset = 22
      if ($signature -eq 0x02014b50) { $sizeOffset = 24 }
      [Array]::Copy([BitConverter]::GetBytes([uint32]4), 0, $zipBytes, $offset + $sizeOffset, 4)
      $changedHeaders++
    }
  }
  Assert-Test ($changedHeaders -eq 2) 'Bomb fixture did not patch both ZIP headers'
  [IO.File]::WriteAllBytes($case.Archive, $zipBytes)
  Assert-Rejected $case 'exceeded its pinned size'
  Assert-Test ((Get-Item -LiteralPath (Join-Path $case.Destination 'bomb.txt')).Length -le 4) 'Decompression exceeded the actual output limit'
  Pass 'forged ZIP lengths cannot exceed the manifest byte limit'

  $case = New-Case @(@{ Name = 'first.txt'; Content = 'first' }, @{ Name = 'keep.txt'; Content = 'valid' }) @((New-Spec 'first.txt' 'first'), (New-Spec 'keep.txt' 'valid'))
  New-Item -ItemType Directory -Path $case.Destination | Out-Null
  [IO.File]::WriteAllText((Join-Path $case.Destination 'keep.txt'), 'existing user content')
  Assert-Rejected $case 'target already exists'
  Assert-Test ([IO.File]::ReadAllText((Join-Path $case.Destination 'keep.txt')) -eq 'existing user content') 'Existing output was overwritten'
  Assert-Test (-not (Test-Path -LiteralPath (Join-Path $case.Destination 'first.txt'))) 'Existing-target rejection occurred after another file was written'
  Pass 'existing output is preserved and all targets are checked before extraction'

  foreach ($nested in @($false, $true)) {
    $case = New-Case @(@{ Name = 'folder/valid.txt'; Content = 'valid' }) @((New-Spec 'folder/valid.txt' 'valid'))
    $outside = Join-Path $case.Folder 'junction-target'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $link = $case.Destination
    if ($nested) {
      New-Item -ItemType Directory -Path $case.Destination | Out-Null
      $link = Join-Path $case.Destination 'folder'
    }
    New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
    Assert-Rejected $case 'Reparse points are not allowed'
    Assert-Test (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'Extraction followed a directory junction'
    # Remove the link itself before recursive test cleanup; its target is also test-owned.
    [IO.Directory]::Delete($link)
  }
  Pass 'destination and nested ancestor junctions cannot redirect extraction'

  Write-Output ("Completed $script:passed extractor fixture groups successfully.")
} finally {
  $cleanupPath = [IO.Path]::GetFullPath($testRoot)
  $resolvedCleanup = (Resolve-Path -LiteralPath $cleanupPath).ProviderPath
  if ($cleanupPath -ne $resolvedCleanup -or -not $cleanupPath.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($cleanupPath) -ne $testName -or $testName -notmatch '^aiplay-runtime-extract-test-[a-f0-9]{32}$') {
    throw 'Refusing unsafe test cleanup'
  }
  Remove-Item -LiteralPath $cleanupPath -Recurse -Force
}
