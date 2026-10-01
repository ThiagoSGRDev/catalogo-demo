-- ============================================
-- TRIAL SYSTEM MIGRATION
-- Execute no Supabase SQL Editor
-- ============================================

-- 1. Adicionar colunas necessárias
ALTER TABLE lojas
ADD COLUMN IF NOT EXISTS trial_expira_em TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '3 days'),
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'trial' CHECK (status IN ('trial', 'ativo', 'cancelado', 'bloqueado')),
ADD COLUMN IF NOT EXISTS data_criacao TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 2. Criar index para performance
CREATE INDEX IF NOT EXISTS idx_lojas_trial_expira ON lojas(trial_expira_em) WHERE status = 'trial';
CREATE INDEX IF NOT EXISTS idx_lojas_status ON lojas(status);

-- 3. Atualizar RLS policy para lojas públicas (leitura)
-- Garantir que lojas ativas e em trial possam ser lidas
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lojas publicas ativas e trial" ON lojas
  FOR SELECT USING (status IN ('ativo', 'trial'));

-- 4. Criar função para verificar trial expirado
CREATE OR REPLACE FUNCTION check_trial_expired()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o trial expirou e status é 'trial', mudar para 'bloqueado'
  IF NEW.status = 'trial' AND NEW.trial_expira_em < NOW() THEN
    NEW.status := 'bloqueado';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Trigger para auto-bloquear trial expirado
CREATE TRIGGER trigger_check_trial_expired
BEFORE UPDATE ON lojas
FOR EACH ROW
EXECUTE FUNCTION check_trial_expired();

-- ============================================
-- Pronto! Sistema de trial está ativo
-- ============================================
