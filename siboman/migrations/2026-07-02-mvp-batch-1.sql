-- ============================================================
-- 逐梦 ERP · MVP 第一批 DB 迁移
-- 生成日期：2026-07-02（Accio 代 Eason 提交）
--
-- 涉及功能：
--   - 02 采集箱          → 新增 collect_items
--   - 11 订单管理增强     → 新增 order_notes
--   - 10 AI 商品套图     → 新增 ai_image_records
--
-- 幂等：所有 DDL 使用 CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- 也已经内嵌在 server.js initDatabase() 里，服务启动会自动执行。
-- 本脚本用于：
--   1. 部署前手动预跑，验证 DDL 无冲突
--   2. 独立环境的一次性初始化
--
-- 回滚脚本：见文件末尾 ROLLBACK 段（默认注释掉，需手动放开）
-- ============================================================

BEGIN;

-- 依赖检查：确认 app_users / app_jobs 存在（否则外键会失败）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_users') THEN
    RAISE EXCEPTION '前置依赖缺失：app_users 表不存在。请先启动一次 server.js 让 initDatabase() 建表。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_jobs') THEN
    RAISE EXCEPTION '前置依赖缺失：app_jobs 表不存在。请先启动一次 server.js 让 initDatabase() 建表。';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 表 1：采集箱 collect_items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collect_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'ozon_url',   -- ozon_url | ozon_sku | manual
  source_value TEXT NOT NULL,
  ozon_url TEXT NOT NULL DEFAULT '',
  ozon_sku TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  main_image TEXT NOT NULL DEFAULT '',
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_cny NUMERIC(12,2),
  seller TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | scraped | uploaded | failed | ignored
  note TEXT NOT NULL DEFAULT '',
  linked_job_id UUID REFERENCES app_jobs(id) ON DELETE SET NULL,
  linked_offer_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collect_items_user_status ON collect_items(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collect_items_user_updated ON collect_items(user_id, updated_at DESC);
COMMENT ON TABLE collect_items IS '采集箱：Ozon 商品链接/SKU 入箱暂存，参考 docs/requirements/02-collect-box.md';

-- ------------------------------------------------------------
-- 表 2：订单本地备注 order_notes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  posting_number TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, posting_number)
);
CREATE INDEX IF NOT EXISTS idx_order_notes_user ON order_notes(user_id, updated_at DESC);
COMMENT ON TABLE order_notes IS 'Ozon 订单本地备注（Ozon 不开放 posting 备注，故本地存），见 docs/requirements/11-order-management.md';

-- ------------------------------------------------------------
-- 表 3：AI 商品套图历史 ai_image_records
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_image_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT 'image-01',
  prompt TEXT NOT NULL DEFAULT '',
  aspect_ratio TEXT NOT NULL DEFAULT '3:4',
  n INTEGER NOT NULL DEFAULT 1,
  has_ref_image BOOLEAN NOT NULL DEFAULT FALSE,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  scene_preset TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_image_records_user ON ai_image_records(user_id, created_at DESC);
COMMENT ON TABLE ai_image_records IS 'MiniMax image-01 生成历史 + 成本累计，见 docs/requirements/10-ai-product-images.md';

COMMIT;

-- ============================================================
-- 验证 SQL（迁移后手动跑一遍）
-- ============================================================
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('collect_items','order_notes','ai_image_records');
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('collect_items','order_notes','ai_image_records');


-- ============================================================
-- 回滚脚本（默认注释；仅在必须回退时手工放开执行）
-- 警告：DROP TABLE 会**永久丢失所有采集箱/订单备注/AI 图历史数据**
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS ai_image_records;
-- DROP TABLE IF EXISTS order_notes;
-- DROP TABLE IF EXISTS collect_items;
-- COMMIT;
