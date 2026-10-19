# Preparação do InHouse no Windows. Chamado pelo setup.cmd e pelo inhouse.cmd
# (dois cliques): ninguém precisa digitar nada no terminal.
#
#   1. Node 24: usa o do computador; se não houver, baixa o Node portátil oficial
#      (nodejs.org), confere o SHA-256 e guarda em %USERPROFILE%\.inhouse\ferramentas\node.
#   2. Dependências do InHouse (npm install), só quando o package-lock mudou.
#   3. Git (com Git Bash), Claude Code e GitHub CLI: server/setup/cli.ts instalar.
#   4. Abre o InHouse; o login do Claude e o nome no Git ficam na tela de preparo.
#
# Opções: -Verificar  só confere (sai 0 se pronto, 1 se falta algo)
#         -Simular    mostra o que faria, sem instalar nada
#         -Basico     só Node e dependências (usado pelo inhouse.cmd)
#         -NaoAbrir   não abre o InHouse no fim
#         -SemPausa   não espera uma tecla no fim
# Rodar de novo é seguro: o que já está pronto é pulado. Não pede senha de administrador.
param(
  [switch]$Verificar,
  [switch]$Simular,
  [switch]$Basico,
  [switch]$NaoAbrir,
  [switch]$SemPausa
)

$ErrorActionPreference = 'Continue'   # nativos (npm, git) escrevem no stderr sem ser erro
$ProgressPreference = 'SilentlyContinue'   # a barra do Invoke-WebRequest deixa o download 10x mais lento
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $raiz

$ferramentas = if ($env:INHOUSE_TOOLS_DIR) { $env:INHOUSE_TOOLS_DIR } else { Join-Path $env:USERPROFILE '.inhouse\ferramentas' }
$urlNode = if ($env:INHOUSE_URL_NODE) { $env:INHOUSE_URL_NODE } else { 'https://nodejs.org/dist/latest-v24.x/' }
$pastaNode = Join-Path $ferramentas 'node'

function Ok($t)    { Write-Host "  [ok]    $t" -ForegroundColor Green }
function Info($t)  { Write-Host "          $t" }
function Passo($t) { Write-Host "  [...]   $t" }
function Falha($t) { Write-Host "  [erro]  $t" -ForegroundColor Red }

function Terminar([int]$codigo) {
  if (-not $SemPausa -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Write-Host 'Aperte qualquer tecla para fechar esta janela.'
    try { [void][Console]::ReadKey($true) } catch {}
  }
  exit $codigo
}

function Forcado($item) {
  $lista = "$($env:INHOUSE_FORCAR_PORTATIL)".Split(',') | ForEach-Object { $_.Trim() }
  return $lista -contains $item
}

function NodeOk {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  try {
    & node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)" 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function PoeNoPath($pasta) {
  if ((Test-Path $pasta) -and -not (($env:Path -split ';') -contains $pasta)) { $env:Path = "$pasta;$env:Path" }
}

function Arquitetura {
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ("$a".ToUpper()) { 'AMD64' { 'x64' } 'X64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
}

# Baixa o Node 24 portátil para $pastaNode, conferindo o SHA-256.
function InstalarNode {
  $arch = Arquitetura
  if (-not $arch) { Falha 'Este computador não é suportado pelo Node 24.'; return $false }
  Passo 'Procurando a versão mais nova do Node 24…'
  try { $somas = (Invoke-WebRequest -UseBasicParsing -Uri "$($urlNode)SHASUMS256.txt" -ErrorAction Stop).Content }
  catch { Falha 'Sem internet para baixar o Node. Confira a conexão e tente de novo.'; return $false }
  if ($somas -is [byte[]]) { $somas = [Text.Encoding]::UTF8.GetString($somas) }
  $linha = ($somas -split "`n") | Where-Object { $_ -match "^([0-9a-f]{64})\s+(node-v24\.\d+\.\d+-win-$arch\.zip)\s*$" } | Select-Object -First 1
  if (-not $linha) { Falha 'Não achei o Node 24 para este computador no site oficial.'; return $false }
  $null = $linha -match "^([0-9a-f]{64})\s+(\S+)"
  $esperado = $Matches[1]; $arquivo = $Matches[2]
  if ($Simular) { Info "Baixaria $urlNode$arquivo (SHA-256 $($esperado.Substring(0,12))…) para $pastaNode"; return $true }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("inhouse-node-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Passo "Baixando $arquivo…"
    $zip = Join-Path $tmp $arquivo
    try { Invoke-WebRequest -UseBasicParsing -Uri "$urlNode$arquivo" -OutFile $zip -ErrorAction Stop }
    catch { Falha 'O download do Node falhou. Confira a internet e tente de novo.'; return $false }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($hash -ne $esperado) { Falha 'O arquivo do Node veio diferente do publicado (checksum). Nada foi instalado.'; return $false }
    Passo 'Extraindo…'
    $x = Join-Path $tmp 'x'
    try { Expand-Archive -Path $zip -DestinationPath $x -Force -ErrorAction Stop } catch { Falha 'Não deu para extrair o Node.'; return $false }
    $topo = Get-ChildItem -Path $x -Directory | Select-Object -First 1
    if (-not $topo -or -not (Test-Path (Join-Path $topo.FullName 'node.exe'))) { Falha 'O pacote do Node veio incompleto.'; return $false }
    New-Item -ItemType Directory -Force -Path $ferramentas | Out-Null
    # Troca atômica: a versão antiga só sai depois que a nova está no lugar.
    $velha = "$pastaNode.old"
    if (Test-Path $velha) { Remove-Item -Recurse -Force $velha }
    if (Test-Path $pastaNode) { Move-Item $pastaNode $velha -ErrorAction Stop }
    try { Move-Item $topo.FullName $pastaNode -ErrorAction Stop }
    catch {
      if (Test-Path $velha) { Move-Item $velha $pastaNode }
      Falha "Não deu para guardar o Node em $ferramentas."; return $false
    }
    if (Test-Path $velha) { Remove-Item -Recurse -Force $velha -ErrorAction SilentlyContinue }
    Ok "Node $(& (Join-Path $pastaNode 'node.exe') -v) instalado em $pastaNode"
    return $true
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '============================================'
Write-Host '   InHouse - preparando o seu computador'
Write-Host '============================================'
Write-Host ''

# --- 1. Node 24 --------------------------------------------------------------
if ((Forcado 'node') -or -not (NodeOk)) { PoeNoPath $pastaNode }
$precisaNode = ((Forcado 'node') -and -not (Test-Path (Join-Path $pastaNode 'node.exe'))) -or -not (NodeOk)
if ($precisaNode) {
  if ($Verificar) { Falha 'Falta o Node 24.'; Terminar 1 }
  if (-not (InstalarNode)) { Terminar 1 }
  if ($Simular -and -not (NodeOk)) { Info '(simulação: o resto precisa do Node)'; Terminar 0 }
  PoeNoPath $pastaNode
}
if (-not (NodeOk)) { Falha 'O Node 24 não ficou disponível.'; Terminar 1 }
Ok "Node $(& node -v)"

# --- 2. Dependências do InHouse ----------------------------------------------
$marca = Join-Path $raiz 'node_modules\.inhouse-deps'
$maior = (& node -p "process.versions.node.split('.')[0]")
$hashDeps = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $raiz 'package-lock.json')).Hash.ToLower() + "-$maior"
$depsOk = (Test-Path $marca) -and ((Get-Content -Raw $marca).Trim() -eq $hashDeps)
if ($depsOk) {
  Ok 'Dependências do InHouse'
} elseif ($Verificar) {
  Falha 'Faltam as dependências do InHouse.'; Terminar 1
} elseif ($Simular) {
  Info 'Rodaria: npm install (dependências do InHouse)'
} else {
  Passo 'Instalando as dependências do InHouse (uns 2 minutos)…'
  & npm install --include=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Falha 'A instalação das dependências falhou. Confira a internet e tente de novo.'; Terminar 1 }
  Set-Content -NoNewline -Encoding ascii -Path $marca -Value $hashDeps
  Ok 'Dependências do InHouse'
}

$tsx = Join-Path $raiz 'node_modules\tsx\dist\cli.mjs'

# --- 3. Git, Claude Code e GitHub CLI ----------------------------------------
if ($Verificar) {
  & node $tsx server/setup/cli.ts verificar
  Terminar $LASTEXITCODE
}
if (-not $Basico) {
  if (-not (Test-Path $tsx)) {
    Info '(simulação: o instalador precisa das dependências)'
  } elseif ($Simular) {
    & node $tsx server/setup/cli.ts instalar --simular
  } else {
    Write-Host ''
    & node $tsx server/setup/cli.ts instalar
    if ($LASTEXITCODE -ne 0) { Info 'Algo ficou faltando. O InHouse vai abrir e mostrar o que falta, com um botão para tentar de novo.' }
  }
  # Caminhos longos: node_modules fundos passam de 260 caracteres no Windows.
  if (-not $Simular -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $lp = (& git config --global --get core.longpaths) 2>$null
    if ($lp -ne 'true') { & git config --global core.longpaths true; Ok 'Ativei os caminhos longos no Git (core.longpaths).' }
  }
}

# --- 4. Abre o InHouse --------------------------------------------------------
if (-not $NaoAbrir -and -not $Simular) {
  Write-Host ''
  Ok 'Abrindo o InHouse…'
  Start-Process -FilePath (Join-Path $raiz 'inhouse.cmd') -WorkingDirectory $raiz
  exit 0
}
Terminar 0
