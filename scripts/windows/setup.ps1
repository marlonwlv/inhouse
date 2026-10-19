# Preparação da máquina para o Inhouse no Windows.
# Chamado pelo setup.cmd (dois cliques). Verifica Node 24+, git (com Git Bash),
# Claude Code e gh, e instala as dependências do Inhouse.
# Não falha "feio": quando algo falta, explica o que fazer em português.

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$raiz = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $raiz

function Ok($t)    { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Erro($t)  { Write-Host "  [x]  $t" -ForegroundColor Red }
function Info($t)  { Write-Host "       $t" }
function Tem($nome) { [bool](Get-Command $nome -ErrorAction SilentlyContinue) }

Write-Host ''
Write-Host '============================================'
Write-Host '   Inhouse - preparando a sua máquina'
Write-Host '============================================'
Write-Host ''

$faltaEssencial = $false

# --- Node 24+ ---
$nodeOk = $false
if (Tem 'node') {
  $maior = [int](& node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if ($maior -ge 24) { $nodeOk = $true; Ok "Node $(& node -v) encontrado." }
  else { Erro "O Node instalado é antigo ($(& node -v)). O Inhouse precisa do Node 24 ou mais novo." }
} else {
  Erro 'Não encontrei o Node nesta máquina.'
}
if (-not $nodeOk) {
  Info 'Instale o Node 24 de um destes jeitos e rode o setup.cmd de novo:'
  Info '  - https://nodejs.org  (baixe a versão 24 ou "LTS" para Windows)'
  Info '  - ou no PowerShell:  winget install OpenJS.NodeJS.LTS'
  $faltaEssencial = $true
}

# --- Git (e o Git Bash que vem junto) ---
if (Tem 'git') {
  Ok 'git encontrado.'
  $gitExe = (Get-Command git).Source
  $gitRaiz = Split-Path (Split-Path $gitExe -Parent) -Parent
  $bash = Join-Path $gitRaiz 'bin\bash.exe'
  if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path $env:CLAUDE_CODE_GIT_BASH_PATH)) { $bash = $env:CLAUDE_CODE_GIT_BASH_PATH }
  if (Test-Path $bash) { Ok "Git Bash encontrado ($bash)." }
  else { Aviso 'Não achei o Git Bash. O Claude Code e o preview dos apps precisam dele: reinstale o Git for Windows (https://git-scm.com/download/win).' }
  # Caminhos longos: node_modules fundos passam de 260 caracteres no Windows.
  $lp = (& git config --global --get core.longpaths) 2>$null
  if ($lp -ne 'true') {
    & git config --global core.longpaths true
    Ok 'Ativei o suporte a caminhos longos no git (core.longpaths).'
  }
} else {
  Erro 'git NÃO encontrado - é essencial.'
  Info 'Instale o Git for Windows: https://git-scm.com/download/win'
  Info '  (ou no PowerShell:  winget install Git.Git)'
  $faltaEssencial = $true
}

# --- Claude Code ---
$claude = $null
if (Tem 'claude') { $claude = (Get-Command claude).Source }
elseif (Test-Path (Join-Path $env:USERPROFILE '.local\bin\claude.exe')) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
elseif ($env:APPDATA -and (Test-Path (Join-Path $env:APPDATA 'npm\claude.cmd'))) { $claude = Join-Path $env:APPDATA 'npm\claude.cmd' }
if ($claude) {
  Ok "Claude Code encontrado ($claude)."
} else {
  Aviso 'Claude Code NÃO encontrado - ele é essencial.'
  Info 'Instale no PowerShell com:  irm https://claude.ai/install.ps1 | iex'
  Info '  (ou:  npm install -g @anthropic-ai/claude-code)'
  Info "Depois abra um terminal novo, digite  claude  e faça o login."
}

# --- gh (opcional) ---
if (Tem 'gh') { Ok 'gh (GitHub) encontrado.' }
else { Info '- gh (GitHub CLI) é opcional: só serve para abrir Pull Requests automaticamente.' }

Write-Host ''
if ($faltaEssencial) {
  Erro 'Falta instalar o que está acima. Depois rode o setup.cmd de novo.'
  exit 1
}

# --- Dependências do Inhouse ---
Write-Host '  Instalando as dependências do Inhouse (pode levar alguns minutos)...'
& npm install
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Ok 'Tudo pronto!'
  Info 'Agora dê dois cliques em  inhouse.cmd  para abrir o Inhouse.'
  exit 0
} else {
  Write-Host ''
  Erro 'A instalação das dependências falhou. Verifique a internet e tente de novo.'
  exit 1
}
