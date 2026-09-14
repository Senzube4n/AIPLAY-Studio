param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination, [Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# The caller supplies a dedicated staging directory and discards it on failure.
# Validate every entry before creating anything, and never replace an existing file.
function Get-RuntimeName([string]$Name, [bool]$Directory = $false) {
  if ([string]::IsNullOrEmpty($Name)) { throw 'Empty runtime path' }
  $normalized = $Name.Replace('\','/')
  if ($Directory) {
    if (-not $normalized.EndsWith('/')) { throw 'Invalid runtime directory entry' }
    $normalized = $normalized.Substring(0, $normalized.Length - 1)
  }
  if ([string]::IsNullOrEmpty($normalized) -or $normalized.StartsWith('/')) { throw 'Unsafe runtime path' }
  foreach ($part in $normalized.Split('/')) {
    if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or
        $part -match '[<>:"|?*\x00-\x1f]' -or $part -match '[. ]$' -or
        $part -match '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)') {
      throw "Unsafe runtime path: $Name"
    }
  }
  return $normalized
}

function Get-ExistingAttributes([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-SafeDirectories([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrEmpty($current)) {
    $attributes = Get-ExistingAttributes $current
    if ($null -ne $attributes) {
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse points are not allowed: $current" }
      if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw "Runtime parent is not a directory: $current" }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}

$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/') + '\'
Assert-SafeDirectories $root
$allowed = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$manifestFiles = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if ($null -eq $manifestFiles -or @($manifestFiles).Count -eq 0) { throw 'Runtime manifest is empty' }
foreach ($file in $manifestFiles) {
  if ($file.name -isnot [string] -or ($file.bytes -isnot [int] -and $file.bytes -isnot [long]) -or
      $file.bytes -lt 0 -or $file.sha256 -isnot [string] -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Invalid runtime manifest file'
  }
  $name = Get-RuntimeName $file.name
  if ($allowed.ContainsKey($name)) { throw "Duplicate runtime manifest path: $name" }
  $allowed.Add($name, [PSCustomObject]@{ Name = $name; Bytes = [long]$file.bytes; Sha256 = $file.sha256 })
  $parent = $name
  while ($parent.Contains('/')) {
    $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
    [void]$directories.Add($parent)
  }
}
foreach ($directory in $directories) {
  if ($allowed.ContainsKey($directory)) { throw "Runtime file conflicts with a directory: $directory" }
}

$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $records = [Collections.Generic.List[object]]::new()
  foreach ($entry in $zip.Entries) {
    $isDirectory = $entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')
    $name = Get-RuntimeName $entry.FullName $isDirectory
    if (-not $seen.Add($name)) { throw "Duplicate runtime archive path: $name" }
    $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if (($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000)) {
      throw 'Symbolic links, reparse points and special files are not allowed'
    }
    if (($unixType -eq 0x4000 -and -not $isDirectory) -or ($unixType -eq 0x8000 -and $isDirectory)) {
      throw 'Runtime archive file type does not match its path'
    }
    if ($isDirectory) {
      if (-not $directories.Contains($name) -or $entry.Length -ne 0) { throw "Unexpected runtime directory: $name" }
      continue
    }
    if (-not $allowed.ContainsKey($name)) { throw "Unexpected runtime file: $name" }
    $spec = $allowed[$name]
    if ($entry.Length -ne $spec.Bytes) { throw "Runtime size mismatch: $name" }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $spec.Name.Replace('/','\')))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
    Assert-SafeDirectories ([IO.Path]::GetDirectoryName($target))
    if ($null -ne (Get-ExistingAttributes $target)) { throw "Runtime target already exists: $name" }
    $records.Add([PSCustomObject]@{ Entry = $entry; Target = $target; Spec = $spec })
  }
  if ($records.Count -ne $allowed.Count) { throw 'Runtime archive is missing files' }

  $buffer = New-Object byte[] 65536
  foreach ($record in $records) {
    $parent = [IO.Path]::GetDirectoryName($record.Target)
    Assert-SafeDirectories $parent
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-SafeDirectories $parent
    $inputStream = $null
    $outputStream = $null
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $inputStream = $record.Entry.Open()
      $outputStream = [IO.File]::Open($record.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      [long]$written = 0
      while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($count -gt $record.Spec.Bytes - $written) { throw "Runtime output exceeded its pinned size: $($record.Spec.Name)" }
        $outputStream.Write($buffer, 0, $count)
        [void]$hash.TransformBlock($buffer, 0, $count, $null, 0)
        $written += $count
      }
      if ($written -ne $record.Spec.Bytes) { throw "Extracted runtime size mismatch: $($record.Spec.Name)" }
      [void]$hash.TransformFinalBlock([byte[]]@(), 0, 0)
      $actual = [BitConverter]::ToString($hash.Hash).Replace('-','').ToLowerInvariant()
      if ($actual -ne $record.Spec.Sha256) { throw "Extracted runtime checksum mismatch: $($record.Spec.Name)" }
    } finally {
      if ($null -ne $outputStream) { $outputStream.Dispose() }
      if ($null -ne $inputStream) { $inputStream.Dispose() }
      $hash.Dispose()
    }
  }
} finally { $zip.Dispose() }
