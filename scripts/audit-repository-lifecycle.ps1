[CmdletBinding()]
param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\config\repository-lifecycle.json'),
    [switch]$NoLive,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$validStates = @('ACTIVE', 'SUNSET', 'ARCHIVE_READY')
$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json
$entries = @($manifest.repositories)
$errors = [System.Collections.Generic.List[string]]::new()

if ($manifest.schemaVersion -ne 1) {
    $errors.Add("schemaVersion no soportada: $($manifest.schemaVersion)")
}

$duplicateNames = @(
    $entries |
        Group-Object repo |
        Where-Object Count -gt 1 |
        ForEach-Object Name
)
foreach ($name in $duplicateNames) {
    $errors.Add("Repositorio duplicado en el manifiesto: $name")
}

foreach ($entry in $entries) {
    if ([string]::IsNullOrWhiteSpace($entry.repo)) {
        $errors.Add('Hay una entrada sin repo.')
    }
    if ($entry.state -notin $validStates) {
        $errors.Add("Estado invalido para $($entry.repo): $($entry.state)")
    }
    if ([string]::IsNullOrWhiteSpace($entry.reason)) {
        $errors.Add("Falta reason para $($entry.repo)")
    }
}

$liveRepositories = @()
$missingFromManifest = @()
$manifestWithoutLiveRepo = @()
$actualArchivedStillTracked = @()

if (-not $NoLive) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw 'gh no esta instalado o no esta disponible en PATH.'
    }

    foreach ($owner in @($manifest.owners)) {
        $json = & gh repo list $owner --limit 200 --json nameWithOwner,isArchived,isFork,visibility
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo leer el inventario GitHub de $owner."
        }

        $decoded = $json | ConvertFrom-Json
        foreach ($repo in $decoded) {
            if ($repo.visibility -eq 'PRIVATE' -and -not $repo.isFork) {
                $liveRepositories += $repo
            }
        }
    }

    $manifestNames = @($entries.repo)
    $unarchivedNames = @(
        $liveRepositories |
            Where-Object { -not $_.isArchived } |
            ForEach-Object nameWithOwner
    )
    $allLiveNames = @($liveRepositories | ForEach-Object nameWithOwner)

    $missingFromManifest = @($unarchivedNames | Where-Object { $_ -notin $manifestNames })
    $manifestWithoutLiveRepo = @($manifestNames | Where-Object { $_ -notin $allLiveNames })
    $actualArchivedStillTracked = @(
        $liveRepositories |
            Where-Object { $_.isArchived -and $_.nameWithOwner -in $manifestNames } |
            ForEach-Object nameWithOwner
    )

    foreach ($name in $missingFromManifest) {
        $errors.Add("Repositorio privado sin clasificar: $name")
    }
    foreach ($name in $manifestWithoutLiveRepo) {
        $errors.Add("Entrada del manifiesto que GitHub no devolvio: $name")
    }
    foreach ($name in $actualArchivedStillTracked) {
        $errors.Add("Repositorio ya archivado que sigue en el inventario operativo: $name")
    }
}

$stateCounts = @{}
foreach ($state in $validStates) {
    $stateCounts[$state] = @($entries | Where-Object state -eq $state).Count
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# Auditoria de ciclo de vida de repositorios')
$lines.Add('')
$lines.Add("- Manifiesto: $resolvedManifest")
$lines.Add("- Verificado en manifiesto: $($manifest.verifiedAt)")
$lines.Add("- ACTIVE: $($stateCounts.ACTIVE)")
$lines.Add("- SUNSET: $($stateCounts.SUNSET)")
$lines.Add("- ARCHIVE_READY: $($stateCounts.ARCHIVE_READY)")
if (-not $NoLive) {
    $unarchivedCount = @($liveRepositories | Where-Object { -not $_.isArchived }).Count
    $archivedCount = @($liveRepositories | Where-Object isArchived).Count
    $lines.Add("- Repos privados observados: $($liveRepositories.Count)")
    $lines.Add("- Sin archivar: $unarchivedCount")
    $lines.Add("- Archivados: $archivedCount")
}
$lines.Add('')

foreach ($state in $validStates) {
    $lines.Add("## $state")
    $lines.Add('')
    foreach ($entry in @($entries | Where-Object state -eq $state | Sort-Object repo)) {
        $lines.Add("- $($entry.repo): $($entry.reason)")
    }
    $lines.Add('')
}

if ($errors.Count -gt 0) {
    $lines.Add('## Errores')
    $lines.Add('')
    foreach ($item in $errors) {
        $lines.Add("- $item")
    }
}

$report = $lines -join [Environment]::NewLine
if ($OutputPath) {
    $parent = Split-Path -Parent $OutputPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputPath, $report, $utf8WithoutBom)
}

$report
if ($errors.Count -gt 0) {
    exit 1
}
