import { describe, expect, it } from 'vitest';

import { imageModel as nanoBanana2 } from '../nanoBanana2';
import { imageModel as nanoBananaPro } from '../nanoBananaPro';
import { imageModel as gptImage2 } from '../gptImage2';
import { imageModel as gpt25Flare } from '../gptImage25Flare';
import { imageModel as gpt25Sunburst } from '../gptImage25Sunburst';
import type { ImageModelDefinition } from '../../../types';
import type { PricingSettingsSnapshot } from '@/features/canvas/pricing/types';
import { DEFAULT_GRSAI_CREDIT_TIER_ID } from '@/features/canvas/pricing/types';

/**
 * 批次9 定价口径回归锁：GRSAI 积分 ÷20000 = 元（1 点 = ¥0.00005，tier-10 = ¥10/200000 点）。
 * 验收基准：nano-banana-2=¥0.06 / pro=¥0.09 / gpt-image-2=¥0.03 / flare·sunburst=¥0.15。
 * 此前 tier 按 1点=¥0.0001 标定导致报价翻倍（0.13/0.18），此处永久锁定。
 */

const SETTINGS: PricingSettingsSnapshot = {
  displayCurrencyMode: 'cny',
  usdToCnyRate: 7.2,
  preferDiscountedPrice: false,
  grsaiCreditTierId: DEFAULT_GRSAI_CREDIT_TIER_ID,
};

function quoteCny(model: ImageModelDefinition, extraParams?: Record<string, unknown>): number {
  const quote = model.pricing?.quote({
    resolution: '1K',
    extraParams,
    settings: SETTINGS,
  });
  expect(quote).not.toBeNull();
  expect(quote?.currency).toBe('CNY');
  return quote!.amount;
}

describe('grsai 定价口径（积分÷20000=元）', () => {
  it('nano-banana-2 = ¥0.06', () => {
    expect(quoteCny(nanoBanana2)).toBeCloseTo(0.06, 5);
  });

  it('nano-banana-pro = ¥0.09', () => {
    expect(quoteCny(nanoBananaPro)).toBeCloseTo(0.09, 5);
  });

  it('gpt-image-2 = ¥0.03', () => {
    expect(quoteCny(gptImage2)).toBeCloseTo(0.03, 5);
  });

  it('gpt-image-2.5-flare = ¥0.15', () => {
    expect(quoteCny(gpt25Flare)).toBeCloseTo(0.15, 5);
  });

  it('gpt-image-2.5-sunburst = ¥0.15', () => {
    expect(quoteCny(gpt25Sunburst)).toBeCloseTo(0.15, 5);
  });

  it('pro 变体带 grsai_pro_model 时仍按官方点数换算（vt 同价 ¥0.09）', () => {
    expect(
      quoteCny(nanoBananaPro, { grsai_pro_model: 'nano-banana-pro-vt' })
    ).toBeCloseTo(0.09, 5);
  });
});
