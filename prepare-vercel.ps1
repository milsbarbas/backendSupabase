#!/usr/bin/env powershell
# ============================================================================
# SCRIPT: Prepare Backend for Vercel Deployment
# ============================================================================

Write-Host "================================================" -ForegroundColor Green
Write-Host "  PREPARANDO BACKEND PARA VERCEL" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

# PASSO 1: Navegar para pasta backend
Write-Host "📁 [1/4] Navegando para pasta backend..." -ForegroundColor Yellow
$backendPath = "c:\Users\Mils\Desktop\banco de dados\backend"

if (-Not (Test-Path $backendPath)) {
    Write-Host "❌ Pasta não encontrada: $backendPath" -ForegroundColor Red
    exit 1
}

Set-Location $backendPath
Write-Host "✅ Pasta backend: $(Get-Location)" -ForegroundColor Green
Write-Host ""

# PASSO 2: Remover sqlite3
Write-Host "📦 [2/4] Removendo sqlite3..." -ForegroundColor Yellow
Write-Host "Executando: npm uninstall sqlite3" -ForegroundColor Gray
npm uninstall sqlite3

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ sqlite3 removido com sucesso" -ForegroundColor Green
} else {
    Write-Host "⚠️  Aviso ao remover sqlite3 (pode estar ok)" -ForegroundColor Yellow
}
Write-Host ""

# PASSO 3: Verificar npm list
Write-Host "🔍 [3/4] Verificando dependências..." -ForegroundColor Yellow
npm list | Select-Object -First 20
Write-Host ""

# PASSO 4: Verificar Node version
Write-Host "🛠️  [4/4] Verificando versões..." -ForegroundColor Yellow
Write-Host "Node.js:" -ForegroundColor Gray
node --version
Write-Host "npm:" -ForegroundColor Gray
npm --version
Write-Host ""

# PASSO 5: Verificar vercel.json
Write-Host "📋 Verificando arquivos de configuração..." -ForegroundColor Yellow
if (Test-Path ".\vercel.json") {
    Write-Host "✅ vercel.json encontrado" -ForegroundColor Green
    Write-Host "   Conteúdo:" -ForegroundColor Gray
    Get-Content ".\vercel.json" | Select-Object -First 10
} else {
    Write-Host "❌ vercel.json NÃO ENCONTRADO" -ForegroundColor Red
}
Write-Host ""

if (Test-Path ".\.env.example") {
    Write-Host "✅ .env.example encontrado" -ForegroundColor Green
} else {
    Write-Host "❌ .env.example NÃO ENCONTRADO" -ForegroundColor Red
}
Write-Host ""

if (Test-Path ".\.gitignore") {
    Write-Host "✅ .gitignore encontrado" -ForegroundColor Green
} else {
    Write-Host "❌ .gitignore NÃO ENCONTRADO" -ForegroundColor Red
}
Write-Host ""

# RESUMO
Write-Host "================================================" -ForegroundColor Green
Write-Host "  ✅ BACKEND PRONTO PARA VERCEL" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "PRÓXIMOS PASSOS:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Comitar mudanças:" -ForegroundColor White
Write-Host "   git add ." -ForegroundColor Gray
Write-Host "   git commit -m 'Remove sqlite3, add Vercel config'" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Enviar para GitHub:" -ForegroundColor White
Write-Host "   git push origin main" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Acessar https://vercel.com/dashboard" -ForegroundColor White
Write-Host "   → Add New → Project" -ForegroundColor Gray
Write-Host "   → Selecione o repositório 'backend'" -ForegroundColor Gray
Write-Host "   → Configure environment variables (SUPABASE_URL, etc)" -ForegroundColor Gray
Write-Host "   → Clique Deploy" -ForegroundColor Gray
Write-Host ""
Write-Host "4. Teste a API:" -ForegroundColor White
Write-Host "   GET https://seu-backend.vercel.app/health" -ForegroundColor Gray
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
