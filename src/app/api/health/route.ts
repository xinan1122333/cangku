import { ok } from '@/lib/http';
import type { HealthDto } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/health —— 健康检查（无需登录，不打开数据库） */
export async function GET() {
  const data: HealthDto = {
    status: 'ok',
    version: process.env.npm_package_version ?? '0.1.0',
    time: Date.now(),
  };
  return ok(data);
}
