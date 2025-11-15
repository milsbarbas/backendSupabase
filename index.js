import express from 'express'
import cors from 'cors'
import { supabase } from './supabaseClient.js'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import crypto from 'crypto'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const siteUrl = process.env.SITE_URL || `http://localhost:${port}`

// Configuração CORS mais permissiva para desenvolvimento
// Deve rodar antes de qualquer rota para garantir que os headers estejam presentes
app.use(cors({
  origin: '*', // Permite todas as origens em desenvolvimento
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))

// Aumentar o limite do body parser para aceitar payloads maiores (PDFs em base64)
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))
app.use('/uploads', express.static('uploads'))

// Configuração do Multer para upload de arquivos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Detectar tipo de upload (contracts ou posts)
    const isPost = req.path.includes('/posts') || req.body?.tipo === 'post'
    const dir = isPost ? 'uploads/posts/' : 'uploads/contracts/'
    
    // Criar diretório se não existir
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    cb(null, dir)
  },
  filename: function (req, file, cb) {
    const isPost = req.path.includes('/posts') || req.body?.tipo === 'post'
    const prefix = isPost ? 'post_' : 'contract_'
    cb(null, `${prefix}${Date.now()}_${file.originalname}`)
  }
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Debug endpoint - verifica se o Supabase está configurado
app.get('/debug/config', (req, res) => {
  const url = process.env.SUPABASE_URL || 'NÃO CONFIGURADO'
  const key = process.env.SUPABASE_SERVICE_KEY ? '***CONFIGURADO***' : 'NÃO CONFIGURADO'
  const port = process.env.PORT || 3000
  const allEnvVars = Object.keys(process.env).filter(k => k.includes('SUPABASE') || k.includes('DATABASE') || k.includes('PORT'))
  
  res.json({
    timestamp: new Date().toISOString(),
    environment: {
      SUPABASE_URL: url === 'NÃO CONFIGURADO' ? 'NÃO CONFIGURADO' : (url.substring(0, 50) + '...'),
      SUPABASE_SERVICE_KEY_CONFIGURED: key,
      PORT: port,
      NODE_ENV: process.env.NODE_ENV || 'não definido',
      ENV_VARS_ENCONTRADAS: allEnvVars.length > 0 ? allEnvVars : ['NENHUMA VAR DE SUPABASE ENCONTRADA']
    },
    supabaseClient: {
      url: supabase?.url || 'indisponível',
      hasClient: !!supabase
    }
  })
})

// Test login endpoint - testa login sem persistência
app.post('/test-login', async (req, res) => {
  try {
    console.log('[TEST-LOGIN] Recebendo requisição:', req.body)
    const { email, senha } = req.body
    
    if (!email || !senha) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' })
    }

    console.log('[TEST-LOGIN] Consultando Supabase para:', email)
    const startTime = Date.now()
    
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('senha', senha)

    const duration = Date.now() - startTime
    console.log(`[TEST-LOGIN] Query levou ${duration}ms`)

    if (error) {
      console.error('[TEST-LOGIN] Erro Supabase:', error)
      return res.status(500).json({ 
        error: 'Erro ao consultar banco de dados',
        details: error.message,
        code: error.code
      })
    }

    if (!data || data.length === 0) {
      console.log('[TEST-LOGIN] Credenciais inválidas')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    console.log('[TEST-LOGIN] Login bem-sucedido para:', email)
    res.json({ 
      success: true,
      user: data[0],
      message: 'Login bem-sucedido'
    })
  } catch (error) {
    console.error('[TEST-LOGIN] Erro:', error)
    res.status(500).json({ 
      error: 'Erro ao processar login',
      details: error.message
    })
  }
})

// Marcar um treino como concluído (salva um registro de progresso separado)
app.post('/treinos/:id/concluir', async (req, res) => {
  try {
    const treinoId = req.params.id
    const { aluno_email, peso_corporal, loads, dados } = req.body || {}
    if (!treinoId) return res.status(400).json({ error: 'treino id é obrigatório na URL' })
    if (!aluno_email) return res.status(400).json({ error: 'aluno_email é obrigatório no body' })

    // Normalizar
    const alunoEmail = aluno_email.toString().trim().toLowerCase()

    const payload = {
      aluno_email: alunoEmail,
      treino_id: treinoId,
      peso_corporal: peso_corporal == null ? null : peso_corporal,
      loads: loads || null,
      dados: dados || null,
      criado_em: new Date().toISOString()
    }

    // Inserir na tabela progresso (criá-la se necessário via SQL fornecido)
    try {
      const { data, error } = await supabase.from('progresso').insert([payload]).select()
      if (error) throw error

      // Tentar notificar o professor (se conhecido)
      try {
        const { data: alunoUser } = await supabase.from('users').select('id,email,criado_por').eq('email', alunoEmail).maybeSingle()
        const professorEmail = alunoUser && alunoUser.criado_por ? alunoUser.criado_por : null
        if (professorEmail) {
          const mensagem = `O aluno ${alunoEmail} concluiu um treino (id ${treinoId}) com ${payload.peso_corporal || '—'} kg e progresso ${payload.dados && payload.dados.percent ? payload.dados.percent + '%' : '—'}.`;
          await supabase.from('mensagens').insert([{ de: alunoEmail, para: professorEmail, mensagem, data: new Date().toISOString() }])
        }
      } catch (notifyErr) {
        console.warn('[POST /treinos/:id/concluir] falha ao notificar professor:', notifyErr && notifyErr.message)
      }

      return res.json(data || [])
    } catch (err) {
      if (err && err.code === 'PGRST205') {
        return res.status(500).json({ error: "Tabela 'progresso' não encontrada. Execute backend/create_progresso_table.sql no Supabase SQL Editor." })
      }
      throw err
    }
  } catch (error) {
    console.error('[POST /treinos/:id/concluir] erro:', error)
    res.status(500).json({ error: 'Erro ao marcar treino como concluído', details: error.message })
  }
})

// Endpoint de progresso: retorna registros de progresso (treinos concluídos) e consultorias para um aluno
app.get('/progresso/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').toString().trim().toLowerCase()
    if (!email) return res.status(400).json({ error: 'email é obrigatório' })

    // Buscar usuário para resolver client_id (id numérico) e criado_por
    const { data: user, error: userErr } = await supabase.from('users').select('id,email,criado_por').eq('email', email).maybeSingle()
    if (userErr) throw userErr

    // Colete registros de progresso (se tabela existir)
    let progressoRows = []
    try {
      const { data: pRows, error: pErr } = await supabase.from('progresso').select('*').eq('aluno_email', email).order('criado_em', { ascending: false })
      if (pErr) throw pErr
      progressoRows = pRows || []
    } catch (pErr) {
      if (pErr && pErr.code === 'PGRST205') {
        // tabela ausente — não falhar, apenas logar e continuar
        console.warn('[GET /progresso] tabela progresso ausente:', pErr.message || pErr)
        progressoRows = []
      } else {
        throw pErr
      }
    }

    // Colete consultorias (bio) vinculadas ao usuário (client_id == user.id)
    let consultoriasRows = []
    if (user && user.id) {
      try {
        const { data: cRows, error: cErr } = await supabase.from('consultorias').select('*').eq('client_id', user.id).order('data', { ascending: false })
        if (cErr) throw cErr
        consultoriasRows = cRows || []
      } catch (cErr) {
        console.warn('[GET /progresso] falha ao buscar consultorias:', cErr && cErr.message)
        consultoriasRows = []
      }
    }

    // Mapear registros para formato esperado pelo frontend: { criado_em, dados }
    const mappedProgresso = (progressoRows || []).map(r => ({
      criado_em: r.criado_em || r.created_at || r.data || null,
      treino_id: r.treino_id || r.treinoId || null,
      dados: Object.assign({}, r.dados || {}, { peso_corporal: r.peso_corporal || (r.dados && r.dados.peso_corporal) || null, loads: r.loads || (r.dados && r.dados.loads) || null })
    }))

    const mappedConsultorias = (consultoriasRows || []).map(r => ({
      criado_em: r.data || r.criado_em || null,
      dados: r.dados || {}
    }))

    // Combinar e ordenar por data desc
    const combined = mappedProgresso.concat(mappedConsultorias)
    combined.sort((a, b) => {
      const ta = a.criado_em ? new Date(a.criado_em).getTime() : 0
      const tb = b.criado_em ? new Date(b.criado_em).getTime() : 0
      return tb - ta
    })

    res.json(combined)
  } catch (error) {
    console.error('[GET /progresso/:email] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar progresso', details: error.message })
  }
})

const upload = multer({ storage: storage })

// Configuração CORS mais permissiva para desenvolvimento
// CORS: permitir métodos usados pelo frontend. Em dev permitimos todas as origens,
// mas em produção você deve restringir a origem e desativar `credentials: true` quando usar '*'.
// (moved earlier in the file so middleware runs before routes)

// Rota raiz
app.get('/', (req, res) => {
  res.json({ 
    message: 'API está funcionando!',
    endpoints: {
      users: '/users',
      treinos: '/treinos',
      contracts: '/contracts'
    }
  })
})

// Rotas para usuários
app.get('/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
    
    // debug: log raw response to server console to help diagnose empty results
    console.log('[GET /users] supabase response:', { dataSummary: Array.isArray(data) ? data.length + ' rows' : data, error })

    if (error) throw error
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Rotas para treinos
app.get('/treinos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('treinos')
      .select('*')
    
    if (error) throw error
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Endpoint leve usado pelo frontend para checar disponibilidade do servidor
app.get('/treinos-debug', async (req, res) => {
  try {
    // simples verificação de saúde — não acessa DB para manter leve
    return res.json({ ok: true, time: new Date().toISOString() })
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) })
  }
})

// Buscar treinos por aluno (aluno_email)
app.get('/treinos/:aluno_email', async (req, res) => {
  try {
    const aluno = decodeURIComponent(req.params.aluno_email || '')
    if (!aluno) return res.status(400).json({ error: 'aluno_email é obrigatório' })
    const { data, error } = await supabase
      .from('treinos')
      .select('*')
      .eq('aluno_email', aluno)
      .order('data', { ascending: false })

    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[GET /treinos/:aluno_email] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar treinos', details: error.message })
  }
})

// Inserir novo treino (salva fichas/treino para um aluno)
app.post('/treinos', async (req, res) => {
  try {
    const { aluno_email, treino, data: dataField } = req.body || {}
    if (!aluno_email || !treino) return res.status(400).json({ error: 'aluno_email e treino são obrigatórios' })

    const payload = {
      aluno_email,
      treino: typeof treino === 'string' ? treino : JSON.stringify(treino),
      data: dataField || new Date().toISOString()
    }

    console.log('[POST /treinos] payload:', { aluno_email, items: Array.isArray(JSON.parse(payload.treino || '[]')) ? JSON.parse(payload.treino).length : 'unknown' })

    const { data, error } = await supabase.from('treinos').insert([payload]).select()
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[POST /treinos] erro:', error)
    res.status(500).json({ error: 'Erro ao salvar treino', details: error.message })
  }
})

// Rotas para contratos
app.post('/contracts', upload.single('file'), async (req, res) => {
  try {
    // Normalize payload and handle embedded base64 PDF or signature to save as files
    const body = { ...req.body }

    // If multer provided a file, prefer that
    if (req.file) {
      body.file_path = req.file.path
    }

    // If client sent pdf_base64 in the body, save it to disk and set pdf_path
    if (body.pdf_base64) {
      try {
        const raw = body.pdf_base64.toString()
        const base = raw.includes(',') ? raw.split(',')[1] : raw
        const filename = `contract_${Date.now()}.pdf`
        const outPath = path.join('uploads', 'contracts', filename)
        fs.writeFileSync(outPath, Buffer.from(base, 'base64'))
        body.pdf_path = `uploads/contracts/${filename}`
        delete body.pdf_base64
      } catch (e) {
        console.warn('[POST /contracts] falha ao salvar pdf_base64 localmente:', e && e.message)
      }
    }

    // If there's a signature image inside dados.signature or signature (data URL), save it
    try {
      const dados = body.dados || {}
      const sigCandidate = dados.signature || body.signature || null
      if (sigCandidate && typeof sigCandidate === 'string' && sigCandidate.startsWith('data:')) {
        const raw = sigCandidate
        const base = raw.includes(',') ? raw.split(',')[1] : raw
        const filename = `signature_${Date.now()}.png`
        const outPath = path.join('uploads', 'contracts', filename)
        fs.writeFileSync(outPath, Buffer.from(base, 'base64'))
        body.signature_path = `uploads/contracts/${filename}`
        // remove embedded signature from dados to avoid storing big base64 in DB
        if (dados.signature) delete dados.signature
        if (body.signature) delete body.signature
        body.dados = dados
      }
    } catch (e) {
      console.warn('[POST /contracts] falha ao salvar assinatura embutida:', e && e.message)
    }

    // Normalizar emails para lowercase
    if (body.aluno_email) {
      body.aluno_email = String(body.aluno_email).toLowerCase().trim()
    }
    if (body.professor_email) {
      body.professor_email = String(body.professor_email).toLowerCase().trim()
    }

    // Filtrar apenas as colunas que existem na tabela contracts
    // Tentar com professor_email se temos, mas fallback para simples se não existir
    let contractRecord = {
      aluno_email: body.aluno_email || null,
      arquivo_path: body.pdf_path || body.arquivo_path || body.file_path || null
    }

    // Tentar adicionar campos opcionais
    if (body.professor_email) {
      contractRecord.professor_email = body.professor_email
      console.log('[POST /contracts] ✅ Professor email será salvo:', body.professor_email)
    }
    if (body.dados) {
      contractRecord.dados = body.dados
    }
    if (body.data_assinatura) {
      contractRecord.data_assinatura = body.data_assinatura
    }

    console.log('[POST /contracts] Tentando inserir contract com campos:', Object.keys(contractRecord))

    let insertResult = await supabase.from('contracts').insert([ contractRecord ])
    
    // Se falhar por coluna não existe, tenta versão simplificada
    if (insertResult.error && insertResult.error.message && /does not exist|coluna|column/i.test(insertResult.error.message)) {
      console.warn('[POST /contracts] Erro com campos complexos, tentando versão simplificada:', insertResult.error.message)
      contractRecord = {
        aluno_email: body.aluno_email || null,
        arquivo_path: body.pdf_path || body.arquivo_path || body.file_path || null
      }
      insertResult = await supabase.from('contracts').insert([ contractRecord ])
    }

    const { data, error } = insertResult

    console.log('[POST /contracts] Resultado:', { hasError: !!error, hasData: !!data, errorMsg: error?.message })

    if (error) throw error
    console.log('[POST /contracts] ✅ Contract inserido com sucesso:', data)
    res.json(data)
  } catch (error) {
    console.error('[POST /contracts] Erro ao salvar contrato:', error)
    res.status(500).json({ error: error.message })
  }
})

// --- Contract settings (per professor + aluno) ---
// Salvar/atualizar configurações de contrato para um aluno (upsert)
app.post('/contract-settings', async (req, res) => {
  try {
    const payload = req.body || {}
    const required = ['professor_email', 'aluno_email']
    for (const k of required) if (!payload[k]) return res.status(400).json({ error: `${k} é obrigatório` })

    // Normalize
    payload.professor_email = payload.professor_email.toString().trim().toLowerCase()
    payload.aluno_email = payload.aluno_email.toString().trim().toLowerCase()

    // Upsert: usa a combinação professor_email + aluno_email como chave única
    const upsertPayload = {
      professor_email: payload.professor_email,
      aluno_email: payload.aluno_email,
      professor_name: payload.professor_name || null,
      professor_cref: payload.professor_cref || null,
      option1_value: payload.option1_value == null ? null : payload.option1_value,
      option2_value: payload.option2_value == null ? null : payload.option2_value,
      updated_at: new Date().toISOString()
    }

    console.log('[POST /contract-settings] upsert payload:', upsertPayload)
    try {
      const { data, error } = await supabase.from('contract_settings').upsert([upsertPayload], { onConflict: 'professor_email,aluno_email' }).select()
      if (error) throw error
      return res.json(data || [])
    } catch (err) {
      // If the table doesn't exist, return a helpful message
      if (err && err.code === 'PGRST205') {
        console.error('[POST /contract-settings] tabela contract_settings ausente:', err)
        return res.status(500).json({ error: 'Tabela contract_settings não encontrada no banco. Execute create_contract_settings_table.sql no Supabase SQL Editor.' })
      }

      // If ON CONFLICT fails because there's no unique constraint, emulate upsert:
      // error code 42P10 = there is no unique or exclusion constraint matching the ON CONFLICT specification
      if (err && err.code === '42P10') {
        console.warn('[POST /contract-settings] ON CONFLICT falhou por falta de constraint única — executando upsert manual (UPDATE então INSERT)')
        try {
          // Tentar UPDATE primeiro
          const { data: updated, error: updateErr } = await supabase.from('contract_settings')
            .update(upsertPayload)
            .eq('professor_email', upsertPayload.professor_email)
            .eq('aluno_email', upsertPayload.aluno_email)
            .select()

          if (updateErr) throw updateErr
          if (Array.isArray(updated) && updated.length > 0) {
            return res.json(updated)
          }

          // Se não atualizou nada, inserir
          const { data: inserted, error: insertErr } = await supabase.from('contract_settings').insert([upsertPayload]).select()
          if (insertErr) throw insertErr
          return res.json(inserted || [])
        } catch (manualErr) {
          console.error('[POST /contract-settings] erro ao executar upsert manual:', manualErr)
          return res.status(500).json({ error: 'Erro ao salvar configurações de contrato (upsert manual falhou)', details: manualErr.message })
        }
      }

      // outro erro — propagar para o catch externo
      throw err
    }
  } catch (error) {
    console.error('[POST /contract-settings] erro:', error)
    res.status(500).json({ error: 'Erro ao salvar configurações de contrato', details: error.message })
  }
})

// Buscar configurações de contrato para professor+aluno
app.get('/contract-settings/:professor_email/:aluno_email', async (req, res) => {
  try {
    const professor = decodeURIComponent(req.params.professor_email || '').toString().trim().toLowerCase()
    const aluno = decodeURIComponent(req.params.aluno_email || '').toString().trim().toLowerCase()
    if (!professor || !aluno) return res.status(400).json({ error: 'professor_email e aluno_email são obrigatórios' })
    const { data, error } = await supabase.from('contract_settings').select('*').eq('professor_email', professor).eq('aluno_email', aluno).maybeSingle()
    if (error) throw error
    res.json(data || {})
  } catch (error) {
    console.error('[GET /contract-settings] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar configurações', details: error.message })
  }
})

// --- Contratos: listagem por professor, leitura por id, exclusão e download de PDF ---
// Listar contratos assinados pelo professor
app.get('/contracts/professor/:professor_email', async (req, res) => {
  try {
    const professor = decodeURIComponent(req.params.professor_email || '').toString().trim().toLowerCase()
    if (!professor) return res.status(400).json({ error: 'professor_email é obrigatório' })
    
    console.log('[GET /contracts/professor] Buscando contratos para professor:', professor)
    
    // Step 1: Buscar todos os alunos deste professor
    const { data: alunosDoProf, error: alunosErr } = await supabase
      .from('users')
      .select('email')
      .eq('criado_por', professor)
    
    if (alunosErr) {
      console.error('[GET /contracts/professor] erro ao buscar alunos:', alunosErr)
      return res.status(500).json({ error: alunosErr.message })
    }
    
    console.log('[GET /contracts/professor] Alunos encontrados para este professor:', alunosDoProf?.length || 0)
    
    if (!alunosDoProf || alunosDoProf.length === 0) {
      console.log('[GET /contracts/professor] Este professor não tem alunos')
      return res.json([])
    }
    
    // Step 2: Extrair emails dos alunos
    const alunosEmails = alunosDoProf.map(a => a.email.toLowerCase())
    console.log('[GET /contracts/professor] Emails dos alunos:', alunosEmails)
    
    // Step 3: Buscar todos os contratos destes alunos
    const { data: allContracts, error } = await supabase.from('contracts').select('*')
    
    if (error) {
      console.error('[GET /contracts/professor] erro ao buscar contratos:', error)
      return res.status(500).json({ error: error.message })
    }
    
    console.log('[GET /contracts/professor] Total de contratos no banco:', allContracts?.length || 0)
    
    // Step 4: Filtrar apenas contratos dos alunos deste professor
    const filtered = allContracts.filter(c => {
      const alunoEmail = (c.aluno_email || '').toLowerCase()
      const isFromThisProfessor = alunosEmails.includes(alunoEmail)
      
      if (isFromThisProfessor) {
        console.log('[GET /contracts/professor] ✓ Contrato encontrado para este professor:', {
          id: c.id,
          aluno_email: c.aluno_email,
          professor_email: c.professor_email
        })
      }
      return isFromThisProfessor
    })
    
    console.log('[GET /contracts/professor] Retornando', filtered.length, 'contratos para', professor)
    return res.json(filtered)
    
  } catch (error) {
    console.error('[GET /contracts/professor] erro:', error)
    return res.status(500).json({ error: error.message })
  }
})

// Debug: Ver TODOS os contratos (sem filtro)
app.get('/contracts-debug/all', async (req, res) => {
  try {
    const { data, error } = await supabase.from('contracts').select('*')
    if (error) throw error
    console.log('[DEBUG] Total de contratos no banco:', data?.length || 0)
    if (data && data.length > 0) {
      console.log('[DEBUG] Primeiro contrato:', JSON.stringify(data[0], null, 2))
    }
    res.json(data || [])
  } catch (error) {
    console.error('[DEBUG] erro:', error)
    res.status(500).json({ error: error.message })
  }
})

// Ler contrato por id
app.get('/contracts/:id', async (req, res) => {
  try {
    const id = req.params.id
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Contrato não encontrado' })
    res.json(data)
  } catch (error) {
    console.error('[GET /contracts/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar contrato', details: error.message })
  }
})

// Baixar/abrir PDF do contrato (se houver file_path ou pdf_path salvo)
app.get('/contracts/:id/pdf', async (req, res) => {
  try {
    const id = req.params.id
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Contrato não encontrado' })
    const filePath = data.pdf_path || data.file_path || data.signature_path
    if (!filePath) return res.status(404).json({ error: 'PDF não encontrado para este contrato' })
    // filePath normalmente é algo como 'uploads/contracts/filename.ext' ou apenas filename
    const filename = filePath.replace(/^uploads\/?/, '')
    const abs = path.join(process.cwd(), 'uploads', filename)
    return res.sendFile(abs)
  } catch (error) {
    console.error('[GET /contracts/:id/pdf] erro:', error)
    res.status(500).json({ error: 'Erro ao obter PDF', details: error.message })
  }
})

// Deletar contrato (verifica professor via query param)
app.delete('/contracts/:id', async (req, res) => {
  try {
    const id = req.params.id
    const professorEmail = (req.query && req.query.professor_email) ? decodeURIComponent(req.query.professor_email).toString().trim().toLowerCase() : null
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    // Buscar contrato
    const { data: existing, error: fetchErr } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
    if (fetchErr) throw fetchErr
    if (!existing) return res.status(404).json({ error: 'Contrato não encontrado' })
    // Autorizar: professorEmail deve bater com criado_por ou professor_email (se fornecido)
    if (professorEmail && existing.criado_por && existing.criado_por.toString().trim().toLowerCase() !== professorEmail && existing.professor_email && existing.professor_email.toString().trim().toLowerCase() !== professorEmail) {
      return res.status(403).json({ error: 'Não autorizado para excluir este contrato' })
    }
    const { error: deleteErr } = await supabase.from('contracts').delete().eq('id', id)
    if (deleteErr) throw deleteErr
    res.json({ deleted: true })
  } catch (error) {
    console.error('[DELETE /contracts/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao deletar contrato', details: error.message })
  }
})

// Rota para criar admin
app.post('/setup-admin', async (req, res) => {
  try {
    console.log('1. Iniciando criação do admin...');
    
    // Primeiro, verifica se a tabela existe
    const { data: tableCheck, error: tableError } = await supabase
      .from('users')
      .select('count')
      .limit(1);

    if (tableError) {
      console.error('Erro ao verificar tabela:', tableError);
      throw new Error('Erro ao verificar tabela: ' + tableError.message);
    }
    console.log('2. Tabela users verificada com sucesso');

    // Verifica se o admin já existe
    const { data: existingAdmin, error: searchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', 'mils@admin.com')
      .maybeSingle();

    console.log('3. Busca por admin existente:', { existingAdmin, searchError });

    if (existingAdmin) {
      console.log('4. Admin já existe:', existingAdmin);
      return res.json({ message: 'Admin já existe', data: existingAdmin });
    }

    // Não envie `id` nem `created_at` — deixe o banco preencher defaults.
    const adminData = {
      email: 'mils@admin.com',
      senha: 'mils123',
      nome: 'Administrador',
      tipo: 'admin'
    };

    console.log('5. Tentando inserir admin:', adminData);
    
    // Tenta inserir o admin
    const { data: insertedData, error: insertError } = await supabase
      .from('users')
      .insert([adminData])
      .select()
      .maybeSingle();
    
    if (insertError) {
      console.error('6. Erro ao inserir admin:', insertError);
      throw new Error('Erro ao inserir admin: ' + insertError.message);
    }

    if (!insertedData) {
      throw new Error('Admin não foi inserido por razão desconhecida');
    }

    console.log('7. Admin criado com sucesso:', insertedData);
    res.json({ 
      message: 'Admin criado com sucesso', 
      data: insertedData,
      adminData: adminData // incluindo os dados que tentamos inserir
    });
  } catch (error) {
    console.error('X. Erro no setup-admin:', error);
    res.status(500).json({ 
      error: 'Erro ao criar admin', 
      details: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
})

// Rota de login
app.post('/login', async (req, res) => {
  try {
    console.log('[Login] Recebendo requisição:', { 
      body: req.body,
      headers: {
        'content-type': req.headers['content-type'],
        'origin': req.headers['origin']
      }
    });

    const { email, senha } = req.body;

    if (!email || !senha) {
      console.log('[Login] Dados incompletos:', { email: !!email, senha: !!senha });
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    console.log('[Login] Buscando usuário:', email);
    // Não usar .single() porque pode haver duplicatas no banco.
    // Buscar todas as correspondências e usar a primeira (mais segura: deduplicar no DB).
    
    let data, error;
    try {
      const startTime = Date.now();
      const result = await Promise.race([
        supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .eq('senha', senha),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Query timeout - Supabase demorando demais')), 10000)
        )
      ]);
      data = result.data;
      error = result.error;
      const duration = Date.now() - startTime;
      console.log(`[Login] Query concluída em ${duration}ms`);
    } catch (timeoutErr) {
      console.error('[Login] Timeout ao consultar Supabase:', timeoutErr.message);
      return res.status(500).json({ 
        error: 'Timeout ao conectar com banco de dados',
        details: timeoutErr.message,
        timestamp: new Date().toISOString()
      });
    }

    if (error) {
      console.error('[Login] Erro do Supabase:', { 
        code: error.code,
        message: error.message,
        details: error.details
      });
      throw error;
    }

    console.log('[Login] supabase retornou (raw):', { rows: Array.isArray(data) ? data.length : (data ? 1 : 0), sample: Array.isArray(data) && data.length ? data[0] : data });

    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.log('[Login] Credenciais inválidas para:', email);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Se houver múltiplos usuários, escolha o primeiro e logue um aviso para limpeza posterior
    let user = Array.isArray(data) ? data[0] : data;
    if (Array.isArray(data) && data.length > 1) {
      console.warn('[Login] Atenção: múltiplos usuários encontrados para o mesmo email. Usando o primeiro. Recomenda-se remover duplicatas no DB. Count=', data.length);
    }
    
    console.log('[Login] Autenticação bem sucedida:', { 
      id: user.id, 
      email: user.email, 
      tipo: user.tipo,
      timestamp: new Date().toISOString()
    });
    res.json(user);
  } catch (error) {
    console.error('[Login] Erro não tratado:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ 
      error: 'Erro ao realizar login', 
      details: error.message,
      stack: error.stack
    });
  }
})

// Teste inicial de conexão com Supabase
const testSupabase = async () => {
  try {
    console.log('Testando conexão com Supabase...')
    const { data, error } = await supabase.from('users').select('count')
    
    if (error) {
      console.error('Erro específico:', error)
      throw error
    }
    
    console.log('Conexão com Supabase estabelecida com sucesso!')
    console.log('Resultado do teste:', data)
    return true
  } catch (error) {
    console.error('Erro ao conectar com Supabase:', error)
    throw error
  }
}

// Rota para renovar contrato do professor com admin
app.post('/admin-contracts/renovar', async (req, res) => {
  try {
    const { professor_email, contract_end } = req.body;
    
    if (!professor_email || !contract_end) {
      return res.status(400).json({ error: 'professor_email e contract_end são obrigatórios' });
    }
    
    // Normalizar a data para formato ISO 8601 completo (YYYY-MM-DD)
    let normalizedDate = contract_end;
    if (typeof contract_end === 'string' && contract_end.length === 10) {
      // Se é apenas YYYY-MM-DD, adicionar time zone UTC
      normalizedDate = contract_end + 'T00:00:00Z';
    }
    
    console.log('[Admin Contracts] Renovando contrato:', { professor_email, contract_end, normalizedDate });
    
    // Atualizar tabela admin_contracts
    const { data: updated, error: updateError } = await supabase
      .from('admin_contracts')
      .update({ contract_end: normalizedDate, updated_at: new Date().toISOString() })
      .eq('professor_email', professor_email.toLowerCase())
      .select();
    
    if (updateError) {
      console.error('[Admin Contracts] Erro ao atualizar:', updateError);
      // Se não encontrar na tabela admin_contracts, criar um novo registro
      if (updateError.message.includes('No rows found') || updated.length === 0) {
        const { data: inserted, error: insertError } = await supabase
          .from('admin_contracts')
          .insert([{
            professor_email: professor_email.toLowerCase(),
            admin_email: 'mils@admin.com',
            contract_start: new Date().toISOString(),
            contract_end: normalizedDate,
            status: 'active'
          }])
          .select();
        
        if (insertError) {
          throw insertError;
        }
        
        console.log('[Admin Contracts] Contrato criado com sucesso:', inserted);
        return res.json({ message: 'Contrato criado com sucesso', data: inserted });
      }
      if (updateError) throw updateError;
    }
    
    // Também atualizar a tabela users para compatibilidade
    await supabase
      .from('users')
      .update({ contract_end: normalizedDate })
      .eq('email', professor_email.toLowerCase())
      .select();
    
    console.log('[Admin Contracts] Contrato renovado com sucesso:', updated);
    return res.json({ message: 'Contrato renovado com sucesso', data: updated });
    
  } catch (error) {
    console.error('[Admin Contracts] Erro:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Rota para obter contratos do admin
app.get('/admin-contracts', async (req, res) => {
  try {
    console.log('[Admin Contracts] Buscando contratos...');
    
    const { data: contracts, error } = await supabase
      .from('admin_contracts')
      .select('id, professor_email, contract_end, contract_start, status')
      .order('contract_end', { ascending: false });
    
    if (error) {
      console.warn('[Admin Contracts] Erro ao buscar contratos (tabela pode não existir):', error.message);
      // Retornar array vazio se a tabela não existir
      return res.json([]);
    }
    
    // Garantir que as datas estão em formato ISO correto
    const normalized = (contracts || []).map(c => ({
      ...c,
      contract_end: c.contract_end ? new Date(c.contract_end).toISOString().split('T')[0] : null,
      contract_start: c.contract_start ? new Date(c.contract_start).toISOString().split('T')[0] : null
    }));
    
    console.log('[Admin Contracts] Contratos encontrados:', normalized.length);
    return res.json(normalized || []);
    
  } catch (error) {
    console.error('[Admin Contracts] Erro geral:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Inicia o servidor (sempre, pois o app.listen funciona com ES modules)
app.listen(port, async () => {
  try {
    console.log(`Servidor iniciando na porta ${port}...`)
    await testSupabase()
    console.log('Servidor pronto para receber requisições')
  } catch (error) {
    console.error('Erro fatal ao iniciar servidor:', error)
    process.exit(1)
  }
})

// Helper: cria um aluno (reutilizável por múltiplos endpoints)
async function handleCreateAluno(req, res) {
  try {
    // apoiar múltiplos nomes de campo: criado_por, criadoPor, criado_by
    const body = req.body || {}
    let nome = body.nome
    let email = body.email
    let senha = body.senha
    const tipo = body.tipo || 'aluno'
    const contract_end = body.contract_end || body.contractEnd || null
    let criado_por = body.criado_por || body.criadoPor || body.criado_by || null

    if (!nome || !email || !senha) return res.status(400).json({ error: 'nome, email e senha são obrigatórios' })

    // Normalizar campos
    nome = nome.toString().trim()
    email = email.toString().trim().toLowerCase()
    senha = senha.toString()
    if (criado_por) criado_por = criado_por.toString().trim().toLowerCase()

    const payload = { nome, email, senha, tipo, criado_por: criado_por || null }
    if (contract_end) payload.contract_end = contract_end

    console.log('[POST /alunos] payload (normalized):', payload)

    const { data, error, status, statusText } = await supabase.from('users').insert([payload]).select().maybeSingle()
    console.log('[POST /alunos] supabase response:', { status, statusText, error, inserted: data })

    if (error) {
      console.error('[POST /alunos] erro ao inserir (detalhes):', error)
      // detectar conflito de unicidade (email já existe)
      if (error.code === '23505' || (error.details && error.details.toLowerCase().includes('already exists'))) {
        return res.status(409).json({ error: 'Email já cadastrado', details: error.message })
      }
      return res.status(500).json({ error: 'Erro ao inserir usuário', details: error.message, code: error.code, hint: error.details })
    }

    if (!data) {
      console.warn('[POST /alunos] atenção: supabase retornou sem dados inseridos e sem erro explícito')
      return res.status(500).json({ error: 'Inserção não retornou dados' })
    }

    // Se for aluno, também criar registro na tabela alunos para perfil e rede social
    if (tipo === 'aluno') {
      try {
        const { error: alunoError } = await supabase
          .from('alunos')
          .insert({
            email: email,
            nome: nome,
            professor_email: criado_por,
            criado_em: new Date()
          })
        
        if (alunoError) {
          console.warn('[POST /alunos] aviso ao inserir na tabela alunos:', alunoError)
          // Não falhar a criação, apenas avisar
        } else {
          console.log('[POST /alunos] aluno criado também na tabela alunos')
        }
      } catch (alunoErr) {
        console.warn('[POST /alunos] erro ao criar aluno na tabela alunos:', alunoErr)
      }
    }

    return res.json(data)
  } catch (error) {
    console.error('[POST /alunos] erro não tratado:', error)
    return res.status(500).json({ error: 'Erro interno ao criar aluno', details: error.message })
  }
}

// Rota principal (compatibilidade com frontend)
app.post('/alunos', async (req, res) => {
  return handleCreateAluno(req, res)
})

// Rota compatível com frontend React/Next (algumas versões usam esse caminho)
app.post('/api/professor/create-student', async (req, res) => {
  return handleCreateAluno(req, res)
})

// Listar apenas professores (compatibilidade com dashboard)
app.get('/professores', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('tipo', 'professor')
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[GET /professores] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar professores', details: error.message })
  }
})

// Listar alunos (compatibilidade com frontend que chama /alunos)
app.get('/alunos', async (req, res) => {
  try {
    // retornamos apenas usuários com tipo 'aluno'
    const { data, error } = await supabase.from('users').select('*').eq('tipo', 'aluno')
    if (error) {
      console.error('[GET /alunos] erro do supabase:', error)
      throw error
    }
    res.json(data || [])
  } catch (error) {
    console.error('[GET /alunos] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar alunos', details: error.message })
  }
})

// Buscar aluno por id (compatibilidade com frontend que pede /alunos/:id)
app.get('/alunos/:id', async (req, res) => {
  try {
    let id = req.params.id
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    
    // Sanitizar: remover qualquer coisa após ":" se existir
    id = String(id).split(':')[0].trim()
    id = parseInt(id, 10)
    if (!id || isNaN(id)) return res.status(400).json({ error: 'id inválido' })
    
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error('[GET /alunos/:id] erro do supabase:', error)
      throw error
    }
    if (!data) return res.status(404).json({ error: 'Aluno não encontrado' })
    res.json(data)
  } catch (error) {
    console.error('[GET /alunos/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar aluno', details: error.message })
  }
})

// Rota simples para compatibilidade com tentativa de sessão do frontend
app.get('/alunos/session', async (req, res) => {
  try {
    // Este endpoint é opcional no frontend — retornamos objeto vazio para indicar "sem sessão".
    res.json({})
  } catch (error) {
    console.error('[GET /alunos/session] erro:', error)
    res.status(500).json({ error: 'Erro ao verificar sessão', details: error.message })
  }
})

// Renovar/atualizar contrato de um aluno (compatível com /alunos/:id/contract)
app.patch('/alunos/:id/contract', async (req, res) => {
  try {
    const id = req.params.id
    const { contract_end } = req.body || {}
    if (!contract_end) return res.status(400).json({ error: 'contract_end é obrigatório' })

    // normalize to ISO if possible
    let iso = contract_end
    try { iso = new Date(contract_end).toISOString() } catch (e) { /* keep raw */ }

    // determine blocked flag
    let blocked = false
    try {
      const end = new Date(iso)
      if (!isNaN(end.getTime()) && end <= new Date()) blocked = true
    } catch (e) {}

  // Update the user, then fetch the full user record so we have reliable fields to notify (email, tipo, criado_por)
  const { error: updateError } = await supabase.from('users').update({ contract_end: iso, blocked: blocked ? 1 : 0 }).eq('id', id)
  if (updateError) throw updateError
  const { data: user, error: userFetchError } = await supabase.from('users').select('id,email,tipo,criado_por,contract_end,blocked').eq('id', id).maybeSingle()
  if (userFetchError) throw userFetchError
    // Insert a system message notifying the user about contract status change
    try {
      if (user && user.email) {
        if (blocked) {
          // contract expired -> notify user to contact professor
          await supabase.from('mensagens').insert([{ de: 'sistema', para: user.email, mensagem: `Seu contrato expirou. Por favor, contate seu administrador para renovar.`, data: Date.now().toString() }])
        } else {
          // contract renewed/updated -> notify user
          await supabase.from('mensagens').insert([{ de: 'sistema', para: user.email, mensagem: `Seu contrato foi atualizado até ${iso}. Acesse sua conta para mais detalhes.`, data: Date.now().toString() }])
        }
      }
    } catch (e) { console.error('Erro ao inserir mensagem sobre contrato:', e) }

    // Additionally notify the professor (admin -> professor flow)
    try {
      // Determine proper professor email:
      // - if the updated user is a professor, the professor is the user themself (they already get the user notification)
      // - otherwise prefer explicit req.body.professor_email, then user's criado_por
      let professorEmail = null
      try {
        if (user && user.tipo === 'professor') {
          professorEmail = user.email
        } else {
          professorEmail = (req.body && req.body.professor_email) || (user && user.criado_por) || null
        }
      } catch (e) {
        professorEmail = (req.body && req.body.professor_email) || (user && user.criado_por) || null
      }

      // Avoid sending duplicate message to the same email that already received the user notification
      if (professorEmail && user && professorEmail !== user.email) {
        const texto = blocked
          ? `O contrato do aluno ${user.email} expirou. Por favor, verifique e tome as providências necessárias.`
          : `O contrato do aluno ${user.email} foi renovado até ${iso}.`;
        await supabase.from('mensagens').insert([{ de: 'sistema', para: professorEmail, mensagem: texto, data: new Date().toISOString() }])
        console.log('[PATCH /alunos/:id/contract] notificação enviada ao professor:', professorEmail)
      } else if (!professorEmail) {
        console.log('[PATCH /alunos/:id/contract] nenhum professor encontrado para notificar (nenhum professor_email em body nem criado_por no usuário)')
      } else {
        console.log('[PATCH /alunos/:id/contract] professor email igual ao usuário atualizado, evitando duplicata:', professorEmail)
      }
    } catch (e) {
      console.error('Erro ao inserir mensagem para o professor sobre contrato:', e)
    }

    res.json({ id, contract_end: iso, blocked: blocked ? 1 : 0 })
  } catch (error) {
    console.error('[PATCH /alunos/:id/contract] erro:', error)
    res.status(500).json({ error: 'Erro ao atualizar contrato', details: error.message })
  }
})

// Deletar aluno/professor
app.delete('/alunos/:id', async (req, res) => {
  try {
    const id = req.params.id
    const { data, error } = await supabase.from('users').delete().eq('id', id)
    if (error) throw error
    res.json({ deleted: true })
  } catch (error) {
    console.error('[DELETE /alunos/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao deletar usuário', details: error.message })
  }
})

// Mensagens: listar e enviar
app.get('/mensagens', async (req, res) => {
  try {
    const { para, de } = req.query || {}
    let query = supabase.from('mensagens').select('*')
    if (para) query = query.eq('para', para)
    if (de) query = query.eq('de', de)
    const { data, error } = await query
    if (error) throw error
    console.log('[GET /mensagens] retornando dados:', data)
    res.json(data || [])
  } catch (error) {
    console.error('[GET /mensagens] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar mensagens', details: error.message })
  }
})

app.get('/mensagens/para/:email', async (req, res) => {
  try {
    const email = req.params.email
    const { data, error } = await supabase.from('mensagens').select('*').eq('para', email).order('data', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[GET /mensagens/para/:email] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar mensagens para o destinatário', details: error.message })
  }
})

app.post('/mensagens', async (req, res) => {
  try {
    const { de, para, mensagem } = req.body || {}
    if (!de || !para || !mensagem) return res.status(400).json({ error: 'de, para e mensagem são obrigatórios' })
    // NÃO enviar 'data' - deixar o banco usar DEFAULT NOW()
    const payload = { de, para, mensagem }
    console.log('[POST /mensagens] payload:', payload)

    const { data: inserted, error, status, statusText } = await supabase.from('mensagens').insert([payload]).select().maybeSingle()
    console.log('[POST /mensagens] supabase response:', { status, statusText, error, inserted })

    if (error) {
      console.error('[POST /mensagens] erro ao inserir (detalhes):', error)
      // return the supabase error details to help debugging (safe for dev only)
      return res.status(500).json({ error: 'Erro ao salvar mensagem', details: error.message, code: error.code, hint: error.details })
    }

    res.json(inserted)
  } catch (error) {
    console.error('[POST /mensagens] erro não tratado:', error)
    res.status(500).json({ error: 'Erro interno ao enviar mensagem', details: error.message })
  }
})

// Deletar uma mensagem
app.delete('/mensagens/:id', async (req, res) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    
    console.log('[DELETE /mensagens/:id] deletando mensagem:', id)
    const { data: deleted, error } = await supabase.from('mensagens').delete().eq('id', id)
    
    if (error) {
      console.error('[DELETE /mensagens/:id] erro ao deletar:', error)
      return res.status(500).json({ error: 'Erro ao deletar mensagem', details: error.message })
    }
    
    res.json({ deleted: true })
  } catch (error) {
    console.error('[DELETE /mensagens/:id] erro não tratado:', error)
    res.status(500).json({ error: 'Erro ao deletar mensagem', details: error.message })
  }
})

// --- Consultorias (Avaliações/biopedância) ---
// Inserir uma nova consultoria
app.post('/consultorias', async (req, res) => {
  try {
    const { aluno_id, tipo, dados, criado_por } = req.body || {}
    const client_id = aluno_id || req.body.client_id || null
    if (!client_id) return res.status(400).json({ error: 'aluno_id (client_id) é obrigatório' })

    const payload = {
      client_id: parseInt(client_id, 10),
      tipo: tipo || 'consultoria',
      dados: dados || {},
      criado_por: criado_por || null,
      data: new Date().toISOString()
    }

    console.log('[POST /consultorias] inserting payload:', { client_id: payload.client_id, tipo: payload.tipo })

    const { data, error, status, statusText } = await supabase.from('consultorias').insert([payload]).select()
    console.log('[POST /consultorias] supabase response:', { status, statusText, error, inserted: data })
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[POST /consultorias] erro:', error)
    res.status(500).json({ error: 'Erro ao salvar consultoria', details: error.message })
  }
})

// Listar consultorias por client id
app.get('/consultorias/:clientId', async (req, res) => {
  try {
    let clientId = req.params.clientId
    if (!clientId) return res.status(400).json({ error: 'clientId inválido' })
    
    // Sanitizar: remover qualquer coisa após ":" se existir
    clientId = String(clientId).split(':')[0].trim()
    clientId = parseInt(clientId, 10)
    if (!clientId || isNaN(clientId)) return res.status(400).json({ error: 'clientId inválido' })
    
    console.log('[GET /consultorias/:clientId] buscando consultorias para clientId:', clientId)
    
    const { data, error } = await supabase.from('consultorias').select('*').eq('client_id', clientId).order('data', { ascending: false })
    
    if (error) {
      console.error('[GET /consultorias/:clientId] supabase error:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        status: error.status
      })
      
      // Se for erro de tabela não encontrada, retornar array vazio ao invés de erro
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        console.warn('[GET /consultorias/:clientId] Tabela consultorias não existe ainda')
        return res.json([])
      }
      
      return res.status(500).json({ 
        error: 'Erro ao buscar consultorias', 
        details: error.message,
        code: error.code
      })
    }
    
    console.log('[GET /consultorias/:clientId] retornando', data?.length || 0, 'consultorias')
    res.json(data || [])
  } catch (error) {
    console.error('[GET /consultorias/:clientId] erro inesperado:', error)
    res.status(500).json({ error: 'Erro inesperado ao buscar consultorias', message: error.message })
  }
})

// Listar consultorias por email do aluno (resolve id do usuário e consulta consultorias)
app.get('/consultorias/email/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '')
    if (!email) return res.status(400).json({ error: 'email inválido' })
    const { data: user, error: userErr } = await supabase.from('users').select('id,email').eq('email', email).maybeSingle()
    if (userErr) throw userErr
    if (!user || !user.id) return res.json([])
    const { data, error } = await supabase.from('consultorias').select('*').eq('client_id', user.id).order('data', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('[GET /consultorias/email/:email] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar consultorias por email', details: error.message })
  }
})

// Deletar consultoria por id
app.delete('/consultorias/:id', async (req, res) => {
  try {
    const id = req.params.id
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    const { data: existing, error: fetchErr } = await supabase.from('consultorias').select('id').eq('id', id).maybeSingle()
    if (fetchErr) throw fetchErr
    if (!existing) return res.status(404).json({ error: 'Consultoria não encontrada' })
    const { error: deleteErr } = await supabase.from('consultorias').delete().eq('id', id)
    if (deleteErr) throw deleteErr
    res.json({ deleted: true })
  } catch (error) {
    console.error('[DELETE /consultorias/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao deletar consultoria', details: error.message })
  }
})

// Atualizar/Salvar foto do aluno (recebe base64 no body: { foto: 'data:image/...' })
app.put('/alunos/foto/:id', async (req, res) => {
  try {
    let id = req.params.id
    const { foto } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id é obrigatório' })
    
    // Sanitizar: remover qualquer coisa após ":" se existir
    id = String(id).split(':')[0].trim()
    id = parseInt(id, 10)
    if (!id || isNaN(id)) return res.status(400).json({ error: 'id inválido' })
    
    if (!foto) return res.status(400).json({ error: 'campo foto é obrigatório' })

    console.log('[PUT /alunos/foto/:id] salvando foto para aluno id=', id)

    // Atualiza a coluna 'foto' na tabela users
    const { data, error } = await supabase.from('users').update({ foto }).eq('id', id).select().maybeSingle()
    console.log('[PUT /alunos/foto/:id] supabase response:', { error, updated: data })
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Aluno não encontrado para atualizar foto' })
    res.json({ success: true, data })
  } catch (error) {
    console.error('[PUT /alunos/foto/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao salvar foto', details: error.message })
  }
})

// --- Admin: Feature Flags ---
// GET configuração global
app.get('/admin/settings/:chave', async (req, res) => {
  try {
    const chave = req.params.chave
    const { data, error } = await supabase.from('settings').select('*').eq('chave', chave).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Configuração não encontrada' })
    res.json(data)
  } catch (error) {
    console.error('[GET /admin/settings/:chave] erro:', error)
    res.status(500).json({ error: 'Erro ao buscar configuração', details: error.message })
  }
})

// POST/PATCH atualizar configuração global
app.post('/admin/settings/:chave', async (req, res) => {
  try {
    const chave = req.params.chave
    const { valor } = req.body || {}
    if (valor === undefined || valor === null) return res.status(400).json({ error: 'valor é obrigatório' })

    console.log('[POST /admin/settings/:chave] atualizando', chave, 'para', valor)

    // Tentar upsert (atualizar se existe, criar se não)
    const { data, error } = await supabase.from('settings')
      .upsert({ chave, valor, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
      .select()
      .maybeSingle()

    if (error) throw error
    console.log('[POST /admin/settings/:chave] sucesso:', data)
    res.json({ success: true, data })
  } catch (error) {
    console.error('[POST /admin/settings/:chave] erro:', error)
    res.status(500).json({ error: 'Erro ao atualizar configuração', details: error.message })
  }
})

// --- REDE SOCIAL: Posts, Curtidas, Comentários ---

// POST: Criar novo post
app.post('/posts', upload.single('imagem'), async (req, res) => {
  try {
    const { conteudo } = req.body
    const autorEmail = req.body.autor_email || localStorage?.getItem?.('aluno_email') || req.headers['x-user-email']
    const autorNome = req.body.autor_nome || 'Anônimo'

    // Se houver arquivo de imagem, salvar
    let imagemUrl = null
    if (req.file) {
      imagemUrl = `/uploads/posts/${req.file.filename}`
    } else if (req.body.imagem_url) {
      imagemUrl = req.body.imagem_url
    }

    // Validar: precisa de conteúdo OU imagem
    if ((!conteudo || !conteudo.trim()) && !imagemUrl) {
      return res.status(400).json({ error: 'Post precisa ter texto ou imagem' })
    }

    if (!autorEmail) {
      return res.status(400).json({ error: 'Email do autor não fornecido' })
    }

    const { data, error } = await supabase.from('posts').insert([{
      autor_email: autorEmail.toLowerCase().trim(),
      autor_nome: autorNome,
      conteudo: conteudo?.trim() || '',
      imagem_url: imagemUrl,
      criado_em: new Date().toISOString()
    }]).select().single()

    if (error) {
      console.error('[POST /posts] erro ao criar post:', error)
      return res.status(500).json({ error: 'Erro ao criar post', details: error.message })
    }

    console.log('[POST /posts] Post criado:', data.id)
    res.json({ success: true, data })
  } catch (error) {
    console.error('[POST /posts] erro:', error)
    res.status(500).json({ error: 'Erro ao criar post', details: error.message })
  }
})

// GET: Listar posts (feed - paginado)
app.get('/posts/feed/:limit/:offset', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.params.limit) || 20, 100)
    const offset = Math.max(parseInt(req.params.offset) || 0, 0)

    // Buscar posts com ordenação decrescente (mais recentes primeiro)
    const { data: posts, error } = await supabase
      .from('posts')
      .select('*')
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    // Para cada post, contar curtidas e comentários
    const enriched = await Promise.all((posts || []).map(async (post) => {
      const { count: curtidas } = await supabase
        .from('curtidas')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id)

      const { data: comentarios } = await supabase
        .from('comentarios')
        .select('*')
        .eq('post_id', post.id)
        .order('criado_em', { ascending: false })
        .limit(3)

      return {
        ...post,
        curtidas_count: curtidas || 0,
        comentarios_count: comentarios?.length || 0,
        comentarios_preview: comentarios || []
      }
    }))

    res.json(enriched)
  } catch (error) {
    console.error('[GET /posts/feed] erro:', error)
    res.status(500).json({ error: 'Erro ao carregar posts', details: error.message })
  }
})

// POST: Curtir/descurtir post
app.post('/posts/:id/curtir', async (req, res) => {
  try {
    const postId = req.params.id
    const usuarioEmail = req.body.usuario_email || req.headers['x-user-email']

    if (!usuarioEmail) {
      return res.status(400).json({ error: 'Email do usuário não fornecido' })
    }

    // Verificar se já existe curtida
    const { data: existente } = await supabase
      .from('curtidas')
      .select('*')
      .eq('post_id', postId)
      .eq('usuario_email', usuarioEmail.toLowerCase())
      .maybeSingle()

    if (existente) {
      // Remover curtida (descurtir)
      const { error } = await supabase
        .from('curtidas')
        .delete()
        .eq('post_id', postId)
        .eq('usuario_email', usuarioEmail.toLowerCase())

      if (error) throw error
      console.log('[POST /posts/:id/curtir] Descurtida:', postId, usuarioEmail)
      return res.json({ success: true, curtido: false })
    } else {
      // Adicionar curtida
      const { error } = await supabase
        .from('curtidas')
        .insert([{
          post_id: postId,
          usuario_email: usuarioEmail.toLowerCase(),
          criado_em: new Date().toISOString()
        }])

      if (error) throw error
      console.log('[POST /posts/:id/curtir] Curtida adicionada:', postId, usuarioEmail)
      return res.json({ success: true, curtido: true })
    }
  } catch (error) {
    console.error('[POST /posts/:id/curtir] erro:', error)
    res.status(500).json({ error: 'Erro ao curtir post', details: error.message })
  }
})

// POST: Adicionar comentário
app.post('/posts/:id/comentar', async (req, res) => {
  try {
    const postId = req.params.id
    const { texto } = req.body
    const usuarioEmail = req.body.usuario_email || req.headers['x-user-email']
    const usuarioNome = req.body.usuario_nome || 'Anônimo'

    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'Texto do comentário é obrigatório' })
    }

    if (!usuarioEmail) {
      return res.status(400).json({ error: 'Email do usuário não fornecido' })
    }

    const { data, error } = await supabase.from('comentarios').insert([{
      post_id: postId,
      usuario_email: usuarioEmail.toLowerCase(),
      usuario_nome: usuarioNome,
      texto: texto.trim(),
      criado_em: new Date().toISOString()
    }]).select().single()

    if (error) throw error
    console.log('[POST /posts/:id/comentar] Comentário adicionado:', postId)
    res.json({ success: true, data })
  } catch (error) {
    console.error('[POST /posts/:id/comentar] erro:', error)
    res.status(500).json({ error: 'Erro ao comentar', details: error.message })
  }
})

// GET: Verificar se usuário curtiu um post
app.get('/posts/:id/curtido-por/:usuario_email', async (req, res) => {
  try {
    const postId = req.params.id
    const usuarioEmail = req.params.usuario_email

    const { data } = await supabase
      .from('curtidas')
      .select('*')
      .eq('post_id', postId)
      .eq('usuario_email', usuarioEmail.toLowerCase())
      .maybeSingle()

    res.json({ curtido: !!data })
  } catch (error) {
    console.error('[GET /posts/:id/curtido-por] erro:', error)
    res.status(500).json({ error: 'Erro ao verificar curtida', details: error.message })
  }
})

// Endpoint: Carregar Perfil do Aluno
app.get('/aluno/perfil/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase()
    
    const { data, error } = await supabase
      .from('alunos')
      .select('nome, email, data_aniversario, bio, foto_url')
      .eq('email', email)
      .maybeSingle()
    
    if (error) throw error
    
    if (!data) {
      return res.json({ email, nome: '', data_aniversario: '', bio: '', foto_url: '' })
    }
    
    res.json(data)
  } catch (error) {
    console.error('[GET /aluno/perfil/:email] erro:', error)
    res.status(500).json({ error: 'Erro ao carregar perfil', details: error.message })
  }
})

// Endpoint: Verificar/Criar Aluno no Login
app.post('/aluno/verify-or-create', async (req, res) => {
  try {
    const { email, nome } = req.body
    
    if (!email) {
      return res.status(400).json({ error: 'Email é obrigatório' })
    }
    
    const emailLower = email.toLowerCase()
    
    // Verificar se aluno já existe
    const { data: existing, error: selectError } = await supabase
      .from('alunos')
      .select('email, nome')
      .eq('email', emailLower)
      .maybeSingle()
    
    if (selectError && selectError.code !== 'PGRST116') {
      throw selectError
    }
    
    if (existing) {
      // Aluno já existe, retornar dados
      return res.json({ created: false, aluno: existing })
    }
    
    // Criar novo aluno
    const { data: newAluno, error: insertError } = await supabase
      .from('alunos')
      .insert({
        email: emailLower,
        nome: nome || emailLower.split('@')[0],
        criado_em: new Date()
      })
      .select('email, nome')
      .single()
    
    if (insertError) throw insertError
    
    res.json({ created: true, aluno: newAluno })
  } catch (error) {
    console.error('[POST /aluno/verify-or-create] erro:', error)
    res.status(500).json({ error: 'Erro ao verificar/criar aluno', details: error.message })
  }
})

// Endpoint: Extrair metadados do Mercado Livre (título e imagem)
app.post('/produtos/extract-ml', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    // Usar fetch para buscar o HTML da página
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(400).json({ error: 'Não conseguiu acessar o link' });
    }

    const html = await response.text();

    // Extrair título (og:title)
    const tituloMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const titulo = tituloMatch ? tituloMatch[1].split(' - ')[0].trim() : 'Produto ML';

    // Extrair imagem (og:image)
    const imagemMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    const imagem = imagemMatch ? imagemMatch[1] : '';

    res.json({ 
      titulo: titulo,
      imagem_url: imagem,
      link_mercadolivre: url
    });
  } catch (error) {
    console.error('[POST /produtos/extract-ml] erro:', error);
    res.status(500).json({ error: 'Erro ao extrair metadados', details: error.message });
  }
});

// Endpoint: Listar produtos da loja
app.get('/produtos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('produtos_loja')
      .select('*')
      .eq('ativo', true)
      .order('ordem', { ascending: true })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('[GET /produtos] erro:', error)
    res.status(500).json({ error: 'Erro ao listar produtos', details: error.message })
  }
})

// Endpoint: Criar produto
app.post('/produtos', async (req, res) => {
  try {
    const { titulo, imagem_url, link_mercadolivre } = req.body

    if (!titulo || !imagem_url || !link_mercadolivre) {
      return res.status(400).json({ error: 'Título, imagem e link são obrigatórios' })
    }

    // Pegar o maior 'ordem' e adicionar 1
    const { data: ultimoProduto } = await supabase
      .from('produtos_loja')
      .select('ordem')
      .order('ordem', { ascending: false })
      .limit(1)
      .single()

    const novaOrdem = (ultimoProduto?.ordem || 0) + 1

    const { data, error } = await supabase
      .from('produtos_loja')
      .insert({
        titulo: titulo.trim(),
        imagem_url,
        link_mercadolivre,
        ordem: novaOrdem,
        ativo: true,
        criado_em: new Date().toISOString()
      })
      .select()
      .single()

    if (error) throw error

    res.json({ success: true, data })
  } catch (error) {
    console.error('[POST /produtos] erro:', error)
    res.status(500).json({ error: 'Erro ao criar produto', details: error.message })
  }
})

// Endpoint: Atualizar produto
app.put('/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { titulo, imagem_url, link_mercadolivre, ordem } = req.body

    const updates = {}
    if (titulo) updates.titulo = titulo.trim()
    if (imagem_url) updates.imagem_url = imagem_url
    if (link_mercadolivre) updates.link_mercadolivre = link_mercadolivre
    if (ordem !== undefined) updates.ordem = ordem
    updates.atualizado_em = new Date().toISOString()

    const { data, error } = await supabase
      .from('produtos_loja')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({ success: true, data })
  } catch (error) {
    console.error('[PUT /produtos/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao atualizar produto', details: error.message })
  }
})

// Endpoint: Deletar produto
app.delete('/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('produtos_loja')
      .update({ ativo: false })
      .eq('id', id)

    if (error) throw error

    res.json({ success: true, message: 'Produto deletado' })
  } catch (error) {
    console.error('[DELETE /produtos/:id] erro:', error)
    res.status(500).json({ error: 'Erro ao deletar produto', details: error.message })
  }
})

// Endpoint: Salvar ou atualizar perfil do aluno
app.post('/aluno/perfil', async (req, res) => {
  try {
    const { email, nome, data_aniversario, bio, foto_url } = req.body
    
    if (!email || !nome) {
      return res.status(400).json({ error: 'Email e nome são obrigatórios' })
    }
    
    const emailLower = email.toLowerCase()
    
    // Verificar se aluno existe
    const { data: existing } = await supabase
      .from('alunos')
      .select('email')
      .eq('email', emailLower)
      .maybeSingle()
    
    if (existing) {
      // Atualizar perfil existente
      const { error } = await supabase
        .from('alunos')
        .update({
          nome,
          data_aniversario: data_aniversario || null,
          bio: bio || null,
          foto_url: foto_url || null,
          atualizado_em: new Date()
        })
        .eq('email', emailLower)
      
      if (error) throw error
      res.json({ success: true, message: 'Perfil atualizado' })
    } else {
      // Criar novo perfil
      const { error } = await supabase
        .from('alunos')
        .insert({
          email: emailLower,
          nome,
          data_aniversario: data_aniversario || null,
          bio: bio || null,
          foto_url: foto_url || null,
          criado_em: new Date()
        })
      
      if (error) throw error
      res.json({ success: true, message: 'Perfil criado' })
    }
  } catch (error) {
    console.error('[POST /aluno/perfil] erro:', error)
    res.status(500).json({ error: 'Erro ao salvar perfil', details: error.message })
  }
})

// Endpoint: Página com Open Graph para compartilhamento em redes sociais
app.get('/produto/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar produto do banco
    const { data, error } = await supabase
      .from('produtos_loja')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Produto não encontrado</title>
          <meta property="og:title" content="Produto não encontrado">
          <meta property="og:description" content="Este produto não existe mais">
        </head>
        <body>
          <h1>Produto não encontrado</h1>
        </body>
        </html>
      `);
    }

    // Extrair nome da aplicação do título ou usar padrão
    const appName = 'Banco de Dados - Fitness';
    
    // Garantir que a imagem existe, se não, tentar extrair do link ML
    let imagemUrl = data.imagem_url;
    if (!imagemUrl && data.link_mercadolivre) {
      try {
        const mlResponse = await fetch(data.link_mercadolivre, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const mlHtml = await mlResponse.text();
        const imgMatch = mlHtml.match(/<meta property="og:image" content="([^"]+)"/);
        if (imgMatch) {
          imagemUrl = imgMatch[1];
        }
      } catch (err) {
        console.error('Erro ao extrair imagem do ML:', err);
      }
    }

    // Tentar extrair múltiplas imagens do ML (até 5)
    let imagens = [];
    if (data.link_mercadolivre) {
      try {
        const mlResponse = await fetch(data.link_mercadolivre, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const mlHtml = await mlResponse.text();
        
        // Procurar por múltiplas imagens
        const imgRegex = /<meta property="og:image" content="([^"]+)"|<img[^>]*src="([^"]*\.(?:jpg|jpeg|png|webp))"[^>]*>/gi;
        let match;
        const urlsEncontradas = new Set();
        
        while ((match = imgRegex.exec(mlHtml)) !== null) {
          const url = match[1] || match[2];
          if (url && url.includes('http') && !url.includes('placeholder')) {
            urlsEncontradas.add(url);
            if (urlsEncontradas.size >= 5) break;
          }
        }
        
        imagens = Array.from(urlsEncontradas).slice(0, 5);
      } catch (err) {
        console.error('Erro ao extrair múltiplas imagens:', err);
      }
    }
    
    // Se não encontrou múltiplas, usar a principal
    if (imagens.length === 0 && imagemUrl) {
      imagens = [imagemUrl];
    }

    // Gerar HTML com slider de fotos
    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${data.titulo} - ${appName}</title>
        
        <!-- Open Graph Meta Tags para Facebook, WhatsApp, etc -->
        <meta property="og:type" content="product">
        <meta property="og:title" content="${data.titulo}">
        <meta property="og:description" content="Confira este produto na nossa loja - ${appName}!">
        <meta property="og:image" content="${imagemUrl}">
        <meta property="og:url" content="${siteUrl}/produto/${data.id}">
        <meta property="og:site_name" content="${appName}">
        
        <!-- Twitter Card Meta Tags -->
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="${data.titulo}">
        <meta name="twitter:description" content="Confira este produto na nossa loja!">
        <meta name="twitter:image" content="${imagemUrl}">
        
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            min-height: 100vh;
            background: #000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
          }
          
          .lightbox {
            width: 100vw;
            height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #1a1a1a 0%, #000 100%);
            position: relative;
            overflow: hidden;
          }
          
          .slider-container {
            position: relative;
            width: 90vw;
            max-width: 700px;
            height: 70vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 20px;
          }
          
          .slider-track {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.5);
            position: relative;
          }
          
          .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.5s ease-in-out;
          }
          
          .slide.active {
            opacity: 1;
            z-index: 10;
          }
          
          .slide img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 8px;
          }
          
          .slide.empty {
            font-size: 80px;
            color: #39ff14;
          }
          
          .slider-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(57, 255, 20, 0.8);
            color: #000;
            border: none;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            cursor: pointer;
            font-weight: 800;
            font-size: 24px;
            transition: all 0.3s;
            z-index: 20;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          
          .slider-nav:hover {
            background: #39ff14;
            transform: translateY(-50%) scale(1.1);
          }
          
          .slider-nav.prev { left: 10px; }
          .slider-nav.next { right: 10px; }
          
          .slider-dots {
            position: absolute;
            bottom: 10px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 8px;
            z-index: 20;
          }
          
          .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            transition: all 0.3s;
            border: 2px solid transparent;
          }
          
          .dot.active {
            background: #39ff14;
            width: 30px;
            border-radius: 5px;
            border: 2px solid #39ff14;
          }
          
          .info-panel {
            background: rgba(0, 0, 0, 0.9);
            padding: 24px;
            text-align: center;
            border-top: 2px solid #39ff14;
            width: 100%;
            max-width: 700px;
            animation: slideUp 0.3s ease-out;
          }
          
          @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          
          .title {
            color: #39ff14;
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 12px;
            word-break: break-word;
          }
          
          .description {
            color: #aaa;
            font-size: 14px;
            margin-bottom: 20px;
          }
          
          .button-group {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
          }
          
          .btn {
            padding: 12px 28px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            font-size: 16px;
            transition: all 0.3s;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
          }
          
          .btn-primary {
            background: #39ff14;
            color: #000;
          }
          
          .btn-primary:hover {
            background: #4dff26;
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(57, 255, 20, 0.4);
          }
          
          .btn-secondary {
            background: transparent;
            color: #39ff14;
            border: 2px solid #39ff14;
          }
          
          .btn-secondary:hover {
            background: #39ff14;
            color: #000;
          }
          
          .emoji { font-size: 20px; }
          
          @media (max-width: 768px) {
            .slider-container { height: 50vh; margin-bottom: 10px; }
            .title { font-size: 18px; }
            .slider-nav { width: 40px; height: 40px; font-size: 20px; }
            .info-panel { padding: 16px; }
            .btn { padding: 10px 20px; font-size: 14px; }
          }
        </style>
      </head>
      <body>
        <div class="lightbox">
          <div class="slider-container">
            <div class="slider-track">
              ${imagens.length > 0 
                ? imagens.map((img, idx) => `
                  <div class="slide ${idx === 0 ? 'active' : ''}">
                    <img src="${img}" alt="${data.titulo}" onerror="this.parentElement.innerHTML='<div class=\\'slide empty\\'>🛍️</div>'">
                  </div>
                `).join('')
                : '<div class="slide active empty">🛍️</div>'
              }
            </div>
            
            ${imagens.length > 1 ? `
              <button class="slider-nav prev" onclick="mudarSlide(-1)">❮</button>
              <button class="slider-nav next" onclick="mudarSlide(1)">❯</button>
              
              <div class="slider-dots">
                ${imagens.map((_, idx) => `
                  <div class="dot ${idx === 0 ? 'active' : ''}" onclick="irParaSlide(${idx})"></div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          
          <div class="info-panel">
            <div class="title">${data.titulo}</div>
            <div class="description">Imagens rolam automaticamente • Clique para visitar no Mercado Livre</div>
            <div style="background:rgba(57,255,20,0.1);border:1px solid #39ff14;padding:12px;border-radius:6px;margin:15px 0;font-size:13px">
              <strong>Link do produto:</strong><br>
              <a href="${data.link_mercadolivre}" target="_blank" style="color:#39ff14;word-break:break-all;text-decoration:none">${data.link_mercadolivre}</a>
            </div>
            <div class="button-group">
              <a href="${data.link_mercadolivre}" target="_blank" class="btn btn-primary">
                <span class="emoji">🛒</span> Visitar Produto
              </a>
              <a href="${data.link_mercadolivre}" target="_blank" class="btn btn-secondary">
                <span class="emoji">🔗</span> Link Direto
              </a>
            </div>
          </div>
        </div>
        
        <script>
          let indiceAtual = 0;
          const slides = document.querySelectorAll('.slide');
          const dots = document.querySelectorAll('.dot');
          const totalSlides = slides.length;
          
          function mostrarSlide(indice) {
            if (totalSlides === 0) return;
            
            // Remover active de todos
            slides.forEach(s => s.classList.remove('active'));
            dots.forEach(d => d.classList.remove('active'));
            
            // Adicionar active ao atual
            slides[indice].classList.add('active');
            if (dots[indice]) dots[indice].classList.add('active');
          }
          
          function mudarSlide(direcao) {
            indiceAtual = (indiceAtual + direcao + totalSlides) % totalSlides;
            mostrarSlide(indiceAtual);
          }
          
          function irParaSlide(indice) {
            indiceAtual = indice;
            mostrarSlide(indiceAtual);
          }
          
          // Teclado: setas
          document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') mudarSlide(-1);
            if (e.key === 'ArrowRight') mudarSlide(1);
          });
          
          // Auto-play: trocar imagem a cada 4 segundos
          setInterval(() => mudarSlide(1), 4000);
        </script>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('[GET /produto/:id] erro:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Erro</title>
      </head>
      <body>
        <h1>Erro ao carregar produto</h1>
      </body>
      </html>
    `);
  }
});

// Exportar app para Vercel serverless
export default app

